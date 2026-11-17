import {
  listNativeCommandSpecsForConfig,
  findCommandByNativeName,
  buildCommandTextFromArgs,
  serializeCommandArgs,
  mergeNativeCommandSpecs,
  type CommandArgs,
  type NativeCommandSpec,
} from "openclaw/plugin-sdk/native-command-registry";
import { listSkillCommandsForAgents } from "openclaw/plugin-sdk/skill-commands-runtime";
import type {
  PluginCommandRuntime,
  PluginCommandNativeCandidate,
  PluginCommandCatalogDecision,
} from "openclaw/plugin-sdk/plugin-command-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  formatChannelMentionsForReader,
  validateBotCommandDefinition,
  validateInteractionOptions,
  type BotCommand,
  type BotCommandDefinition,
  type Channel,
  type InteractionOptions,
} from "@tescord/types";
import type { NekordBotClient } from "@nekord/bot-sdk";
import { localized, localizedCommand, commandLocales } from "./localization.js";
import { ChannelError, type NekordAccount } from "./config.js";
interface Selection {
  spec: NativeCommandSpec;
  definition: BotCommandDefinition;
  candidate?: PluginCommandNativeCandidate;
}
export interface NativeCommandTurn {
  body: string;
  args?: CommandArgs;
  decision: PluginCommandCatalogDecision;
}
export class NativeCommandCatalog {
  readonly #selected = new Map<string, Selection>();
  #registered = new Map<string, Selection>();
  constructor(
    cfg: OpenClawConfig,
    account: NekordAccount,
    runtime: PluginCommandRuntime,
  ) {
    const builtins = listNativeCommandSpecsForConfig(cfg, {
      provider: "nekord",
      skillCommands: listSkillCommandsForAgents({ cfg }),
      includeBundledChannelFallback: true,
    });
    const candidates = runtime.listNativeCandidates("nekord");
    const combined = mergeNativeCommandSpecs({
      primary: builtins,
      secondary: candidates,
    });
    if (combined.length > 100)
      throw new ChannelError("COMMAND_CATALOG_TOO_LARGE");
    for (const spec of combined) {
      const candidate = builtins.some(
        (builtin) => builtin.name.toLowerCase() === spec.name.toLowerCase(),
      )
        ? undefined
        : candidates.find(
            (plugin) => plugin.name.toLowerCase() === spec.name.toLowerCase(),
          );
      const options = spec.args?.length
        ? spec.args.map((argument) => ({
            name: argument.name,
            description: argument.description.slice(0, 100),
            nameLocalizations: localized(() => argument.name),
            descriptionLocalizations: localized((_locale, dictionary) =>
              dictionary.argument
                .replace("{{name}}", argument.name)
                .slice(0, 100),
            ),
            type: argument.type,
            required: argument.required === true,
          }))
        : spec.acceptsArgs
          ? [
              {
                name: "arguments",
                description: commandLocales[account.locale].arguments,
                nameLocalizations: localized((_locale, dictionary) =>
                  dictionary.arguments.replaceAll(" ", "_"),
                ),
                descriptionLocalizations: localized(
                  (_locale, dictionary) => dictionary.arguments,
                ),
                type: "string" as const,
                required: false,
              },
            ]
          : [];
      const definition: BotCommandDefinition = {
        name: spec.name,
        description: spec.description.slice(0, 100),
        ...localizedCommand(
          spec.name,
          spec.description,
          spec.descriptionLocalizations,
        ),
        options,
        ephemeral: !account.publicCommands.includes(spec.name),
      };
      try {
        validateBotCommandDefinition(definition);
      } catch {
        throw new ChannelError("COMMAND_CATALOG_INVALID");
      }
      this.#selected.set(spec.name, {
        spec,
        definition,
        ...(candidate ? { candidate } : {}),
      });
    }
  }
  get definitions(): BotCommandDefinition[] {
    return [...this.#selected.values()].map(
      (selection) => selection.definition,
    );
  }
  async register(client: NekordBotClient, signal?: AbortSignal): Promise<void> {
    const commands = await client.registerCommands(this.definitions, signal);
    const map = new Map<string, Selection>();
    for (const command of commands) {
      const selection = this.#selected.get(command.name);
      if (!selection) throw new ChannelError("COMMAND_CATALOG_INVALID");
      map.set(command.id, selection);
    }
    if (map.size !== this.#selected.size)
      throw new ChannelError("COMMAND_CATALOG_INVALID");
    this.#registered = map;
  }
  prepare(
    command: BotCommand,
    value: unknown,
    channels: readonly Channel[] = [],
  ): NativeCommandTurn {
    const selected = this.#registered.get(command.id);
    if (!selected || selected.definition.name !== command.name)
      throw new ChannelError("COMMAND_UNAVAILABLE");
    validateInteractionOptions(selected.definition, value);
    const options: InteractionOptions = value;
    const builtin = findCommandByNativeName(selected.spec.name, "nekord", {
      includeBundledChannelFallback: true,
    });
    const args: CommandArgs = selected.spec.args?.length
      ? { values: options }
      : { raw: String(options.arguments ?? "") };
    const formatAgentOptionValue = (name: string, val: unknown): string => {
      if (val === undefined) return "";
      const str = String(val);
      const optionDef = selected.definition.options.find(
        (opt) => opt.name === name,
      );
      if (optionDef?.type === "channel") {
        return formatChannelMentionsForReader(`<#${str}>`, channels);
      }
      return str;
    };
    const raw = builtin
      ? (serializeCommandArgs(builtin, args) ?? "")
      : (selected.spec.args
          ?.map((argument) =>
            options[argument.name] === undefined
              ? ""
              : String(options[argument.name]),
          )
          .filter(Boolean)
          .join(" ") ??
        args.raw ??
        "");
    if (selected.candidate) {
      const decision = selected.candidate.prepareDispatch(raw);
      if (decision.kind !== "plugin") throw new ChannelError("COMMAND_RETIRED");
      return {
        body: `/${selected.spec.name}${raw ? ` ${raw}` : ""}`,
        args,
        decision,
      };
    }
    const agentRaw = builtin
      ? formatChannelMentionsForReader(raw, channels)
      : (selected.spec.args
          ?.map((argument) =>
            formatAgentOptionValue(argument.name, options[argument.name]),
          )
          .filter(Boolean)
          .join(" ") ??
        formatChannelMentionsForReader(args.raw ?? "", channels));
    return {
      body: builtin
        ? formatChannelMentionsForReader(
            buildCommandTextFromArgs(builtin, args),
            channels,
          )
        : `/${selected.spec.name}${agentRaw ? ` ${agentRaw}` : ""}`,
      args,
      decision: { kind: "non-plugin" },
    };
  }
}
