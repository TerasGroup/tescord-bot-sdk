import cn from "./locales/zh-CN/commands.json" with { type: "json" };
import tw from "./locales/zh-TW/commands.json" with { type: "json" };
import hk from "./locales/zh-HK/commands.json" with { type: "json" };
import en from "./locales/en-US/commands.json" with { type: "json" };
import ja from "./locales/ja-JP/commands.json" with { type: "json" };
import type { SupportedLocale, BotLocalizations } from "@tescord/types";
export const commandLocales = {
  "zh-CN": cn,
  "zh-TW": tw,
  "zh-HK": hk,
  "en-US": en,
  "ja-JP": ja,
};
export function localized(
  values: (locale: SupportedLocale, dictionary: typeof en) => string,
): BotLocalizations {
  return Object.fromEntries(
    Object.entries(commandLocales).map(([locale, dictionary]) => [
      locale,
      values(locale as SupportedLocale, dictionary),
    ]),
  ) as BotLocalizations;
}
export function localizedCommand(
  name: string,
  description: string,
  translations?: Readonly<Record<string, string>>,
) {
  return {
    nameLocalizations: localized(
      (_locale, dictionary) =>
        dictionary.commands[name as keyof typeof dictionary.commands]?.name ??
        name,
    ),
    descriptionLocalizations: localized((locale, dictionary) => {
      const supplied =
        translations?.[locale] ??
        (locale === "ja-JP" ? translations?.ja : undefined);
      const value =
        supplied ||
        dictionary.commands[name as keyof typeof dictionary.commands]
          ?.description ||
        (locale === "en-US"
          ? description
          : dictionary.execute.replace("{{name}}", name));
      return [...value].slice(0, 100).join("");
    }),
  };
}
