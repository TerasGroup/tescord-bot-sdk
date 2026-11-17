import {
  ButtonStyle,
  ComponentType,
  TextInputStyle,
  type BotCommandDefinition,
  type BotCommandOptionChoice,
  type InteractionModalData,
  type MessageActionRow,
  type StringSelectOption,
  type SupportedLocale,
} from "@tescord/types";

export const commandNames = ["ping", "hello", "help", "context"] as const;
export type CommandName = (typeof commandNames)[number];

export const gettingStartedCommandNames = [
  "test",
  "challenge",
  "feedback",
] as const;
export type GettingStartedCommandName =
  (typeof gettingStartedCommandNames)[number];

export type RpsObject = "rock" | "paper" | "scissors";

interface Copy {
  descriptions: Record<CommandName, string>;
  replies: Record<CommandName | "contextEmpty" | "unknown", string> & {
    channelMention: (mention: string) => string;
  };
  gettingStarted: {
    testDesc: string;
    testReply: string;
    testButtonLabel: string;
    testClickedReply: string;
    challengeDesc: string;
    challengeOptionName: string;
    challengeOptionDesc: string;
    challengePrompt: (caller: string) => string;
    acceptButtonLabel: string;
    selectPrompt: string;
    selectPlaceholder: string;
    rpsObjects: Record<
      RpsObject,
      { label: string; description: string; emoji: string }
    >;
    rpsResultTie: (p1: string, p2: string, choice: string) => string;
    rpsResultWin: (
      winner: string,
      winnerChoice: string,
      loser: string,
      loserChoice: string,
    ) => string;
    feedbackDesc: string;
    feedbackModalTitle: string;
    feedbackSubjectLabel: string;
    feedbackDetailsLabel: string;
    feedbackReply: (subject: string) => string;
  };
}

export const copy: Record<SupportedLocale, Copy> = {
  "zh-CN": {
    descriptions: {
      ping: "测试连接",
      hello: "发送固定问候",
      help: "查看测试指令",
      context: "测试上下文读取",
    },
    replies: {
      ping: "Pong!",
      hello: "你好，我是 Ciel 测试 Bot。",
      help: "可用指令：/ping、/hello、/help、/context。",
      context: "上下文读取成功。",
      contextEmpty: "当前没有可读取的上下文。",
      unknown: "消息已收到。输入 /help 查看测试指令。",
      channelMention: (mention) => `已识别频道引用：${mention}`,
    },
    gettingStarted: {
      testDesc: "基础测试指令",
      testReply: "hello world ✨",
      testButtonLabel: "点我互动",
      testClickedReply: "hello world ✨（已点击按钮！）",
      challengeDesc: "发起一场石头剪刀布对战挑战",
      challengeOptionDesc: "选择你的出招",
      challengeOptionName: "object",
      challengePrompt: (caller) => `${caller} 发起了石头剪刀布挑战！`,
      acceptButtonLabel: "接受挑战",
      selectPrompt: "请选择你的出招：",
      selectPlaceholder: "做出你的选择",
      rpsObjects: {
        rock: {
          label: "石头 (Rock)",
          description: "沉积岩、火成岩或变质岩",
          emoji: "🪨",
        },
        paper: {
          label: "布 (Paper)",
          description: "致密的植物纤维薄片",
          emoji: "📄",
        },
        scissors: {
          label: "剪刀 (Scissors)",
          description: "双刃精密裁剪工具",
          emoji: "✂️",
        },
      },
      rpsResultTie: (p1, p2, choice) =>
        `${p1} 与 ${p2} 都出了 **${choice}**，平局！`,
      rpsResultWin: (winner, wChoice, loser, lChoice) =>
        `🎉 **${winner}**（${wChoice}）击败了 **${loser}**（${lChoice}）！`,
      feedbackDesc: "打开交互模态框提交反馈",
      feedbackModalTitle: "提交 Bot 反馈",
      feedbackSubjectLabel: "反馈主题",
      feedbackDetailsLabel: "详细内容",
      feedbackReply: (subject) => `感谢你的反馈：**${subject}**！`,
    },
  },
  "zh-TW": {
    descriptions: {
      ping: "測試連線",
      hello: "傳送固定問候",
      help: "查看測試指令",
      context: "測試上下文讀取",
    },
    replies: {
      ping: "Pong!",
      hello: "你好，我是 Ciel 測試 Bot。",
      help: "可用指令：/ping、/hello、/help、/context。",
      context: "上下文讀取成功。",
      contextEmpty: "目前沒有可讀取的上下文。",
      unknown: "訊息已收到。輸入 /help 查看測試指令。",
      channelMention: (mention) => `已識別頻道引用：${mention}`,
    },
    gettingStarted: {
      testDesc: "基礎測試指令",
      testReply: "hello world ✨",
      testButtonLabel: "點我互動",
      testClickedReply: "hello world ✨（已點擊按鈕！）",
      challengeDesc: "發起一場剪刀石頭布對戰挑戰",
      challengeOptionDesc: "選擇你的出招",
      challengeOptionName: "object",
      challengePrompt: (caller) => `${caller} 發起了剪刀石頭布挑戰！`,
      acceptButtonLabel: "接受挑戰",
      selectPrompt: "請選擇你的出招：",
      selectPlaceholder: "做出你的選擇",
      rpsObjects: {
        rock: {
          label: "石頭 (Rock)",
          description: "沉積岩、火成岩或變質岩",
          emoji: "🪨",
        },
        paper: {
          label: "布 (Paper)",
          description: "致密的植物纖維薄片",
          emoji: "📄",
        },
        scissors: {
          label: "剪刀 (Scissors)",
          description: "雙刃精密裁剪工具",
          emoji: "✂️",
        },
      },
      rpsResultTie: (p1, p2, choice) =>
        `${p1} 與 ${p2} 都出了 **${choice}**，平手！`,
      rpsResultWin: (winner, wChoice, loser, lChoice) =>
        `🎉 **${winner}**（${wChoice}）擊敗了 **${loser}**（${lChoice}）！`,
      feedbackDesc: "打開互動對話框提交回饋",
      feedbackModalTitle: "提交 Bot 回饋",
      feedbackSubjectLabel: "回饋主題",
      feedbackDetailsLabel: "詳細內容",
      feedbackReply: (subject) => `感謝你的回饋：**${subject}**！`,
    },
  },
  "zh-HK": {
    descriptions: {
      ping: "測試連線",
      hello: "傳送固定問候",
      help: "查看測試指令",
      context: "測試上下文讀取",
    },
    replies: {
      ping: "Pong!",
      hello: "你好，我是 Ciel 測試 Bot。",
      help: "可用指令：/ping、/hello、/help、/context。",
      context: "上下文讀取成功。",
      contextEmpty: "目前沒有可讀取的上下文。",
      unknown: "已收到訊息。輸入 /help 查看測試指令。",
      channelMention: (mention) => `已識別頻道引用：${mention}`,
    },
    gettingStarted: {
      testDesc: "基礎測試指令",
      testReply: "hello world ✨",
      testButtonLabel: "撳我互動",
      testClickedReply: "hello world ✨（已撳掣！）",
      challengeDesc: "發起一場包剪揼對戰挑戰",
      challengeOptionDesc: "選擇你嘅出招",
      challengeOptionName: "object",
      challengePrompt: (caller) => `${caller} 發起咗包剪揼挑戰！`,
      acceptButtonLabel: "接受挑戰",
      selectPrompt: "請選擇你嘅出招：",
      selectPlaceholder: "做出你嘅選擇",
      rpsObjects: {
        rock: {
          label: "揼 (Rock)",
          description: "沉積岩、火成岩或變質岩",
          emoji: "🪨",
        },
        paper: {
          label: "包 (Paper)",
          description: "致密嘅植物纖維薄片",
          emoji: "📄",
        },
        scissors: {
          label: "剪 (Scissors)",
          description: "雙刃精密裁剪工具",
          emoji: "✂️",
        },
      },
      rpsResultTie: (p1, p2, choice) =>
        `${p1} 同 ${p2} 都出咗 **${choice}**，打和！`,
      rpsResultWin: (winner, wChoice, loser, lChoice) =>
        `🎉 **${winner}**（${wChoice}）贏咗 **${loser}**（${lChoice}）！`,
      feedbackDesc: "開啟互動視窗提交意見",
      feedbackModalTitle: "提交 Bot 意見",
      feedbackSubjectLabel: "意見主題",
      feedbackDetailsLabel: "詳細內容",
      feedbackReply: (subject) => `多謝你嘅意見：**${subject}**！`,
    },
  },
  "en-US": {
    descriptions: {
      ping: "Test the connection",
      hello: "Send a fixed greeting",
      help: "List test commands",
      context: "Test reading message context",
    },
    replies: {
      ping: "Pong!",
      hello: "Hello, I am the Ciel test bot.",
      help: "Available commands: /ping, /hello, /help, /context.",
      context: "Context read successfully.",
      contextEmpty: "There is no readable context yet.",
      unknown: "Message received. Use /help to see test commands.",
      channelMention: (mention) => `Referenced channel: ${mention}`,
    },
    gettingStarted: {
      testDesc: "Basic command",
      testReply: "hello world ✨",
      testButtonLabel: "Click Me!",
      testClickedReply: "hello world ✨ (Button clicked!)",
      challengeDesc: "Challenge to a match of rock paper scissors",
      challengeOptionDesc: "Pick your object",
      challengeOptionName: "object",
      challengePrompt: (caller) =>
        `Rock papers scissors challenge from ${caller}`,
      acceptButtonLabel: "Accept",
      selectPrompt: "Choose your object of choice:",
      selectPlaceholder: "Make your choice",
      rpsObjects: {
        rock: {
          label: "Rock",
          description: "Sedimentary, igneous, or perhaps even metamorphic",
          emoji: "🪨",
        },
        paper: {
          label: "Paper",
          description: "Fibrous pulp made from trees",
          emoji: "📄",
        },
        scissors: {
          label: "Scissors",
          description: "Careful! Sharp edges!",
          emoji: "✂️",
        },
      },
      rpsResultTie: (p1, p2, choice) =>
        `${p1} and ${p2} both chose **${choice}** — it's a tie!`,
      rpsResultWin: (winner, wChoice, loser, lChoice) =>
        `🎉 **${winner}** (${wChoice}) defeated **${loser}** (${lChoice})!`,
      feedbackDesc: "Open an interactive modal to submit feedback",
      feedbackModalTitle: "Submit Bot Feedback",
      feedbackSubjectLabel: "Subject",
      feedbackDetailsLabel: "Details",
      feedbackReply: (subject) => `Thanks for your feedback: **${subject}**!`,
    },
  },
  "ja-JP": {
    descriptions: {
      ping: "接続をテスト",
      hello: "定型の挨拶を送信",
      help: "テストコマンドを表示",
      context: "コンテキストの読み取りをテスト",
    },
    replies: {
      ping: "Pong!",
      hello: "こんにちは、テスト Bot の Ciel です。",
      help: "使用可能なコマンド：/ping、/hello、/help、/context。",
      context: "コンテキストを読み取りました。",
      contextEmpty: "読み取れるコンテキストがまだありません。",
      unknown:
        "メッセージを受信しました。/help でテストコマンドを確認できます。",
      channelMention: (mention) => `参照チャンネル：${mention}`,
    },
    gettingStarted: {
      testDesc: "基本テストコマンド",
      testReply: "hello world ✨",
      testButtonLabel: "クリック！",
      testClickedReply: "hello world ✨（ボタンがクリックされました！）",
      challengeDesc: "じゃんけん対戦を申し込む",
      challengeOptionDesc: "出す手を選択してください",
      challengeOptionName: "object",
      challengePrompt: (caller) => `${caller} がじゃんけん勝負を挑んでいます！`,
      acceptButtonLabel: "勝負を受ける",
      selectPrompt: "出す手を選んでください：",
      selectPlaceholder: "選択してください",
      rpsObjects: {
        rock: {
          label: "グー (Rock)",
          description: "堆積岩、火成岩、あるいは変成岩",
          emoji: "🪨",
        },
        paper: {
          label: "パー (Paper)",
          description: "植物繊維から作られたシート",
          emoji: "📄",
        },
        scissors: {
          label: "チョキ (Scissors)",
          description: "二枚刃の精密切断ツール",
          emoji: "✂️",
        },
      },
      rpsResultTie: (p1, p2, choice) =>
        `${p1} と ${p2} はどちらも **${choice}** を出しました。引き分けです！`,
      rpsResultWin: (winner, wChoice, loser, lChoice) =>
        `🎉 **${winner}**（${wChoice}）が **${loser}**（${lChoice}）に勝利しました！`,
      feedbackDesc: "モーダルを開いてフィードバックを送信",
      feedbackModalTitle: "Bot フィードバックの送信",
      feedbackSubjectLabel: "件名",
      feedbackDetailsLabel: "詳細",
      feedbackReply: (subject) =>
        `フィードバックありがとうございます：**${subject}**！`,
    },
  },
};

export function commandDefinitions(
  locale: SupportedLocale,
): BotCommandDefinition[] {
  return commandNames.map((name) => ({
    name,
    description: copy[locale].descriptions[name],
    nameLocalizations: Object.fromEntries(
      Object.keys(copy).map((key) => [key, name]),
    ) as Record<SupportedLocale, string>,
    descriptionLocalizations: Object.fromEntries(
      Object.entries(copy).map(([key, value]) => [
        key,
        value.descriptions[name],
      ]),
    ) as Record<SupportedLocale, string>,
    options: [],
    ephemeral: true,
  }));
}

export function gettingStartedCommandDefinitions(
  locale: SupportedLocale,
): BotCommandDefinition[] {
  const locales = Object.keys(copy) as SupportedLocale[];
  const rpsKeys: RpsObject[] = ["rock", "paper", "scissors"];
  const choices: BotCommandOptionChoice[] = rpsKeys.map((obj) => ({
    name: copy[locale].gettingStarted.rpsObjects[obj].label,
    nameLocalizations: Object.fromEntries(
      locales.map((loc) => [
        loc,
        copy[loc].gettingStarted.rpsObjects[obj].label,
      ]),
    ) as Record<SupportedLocale, string>,
    value: obj,
  }));

  return [
    {
      name: "test",
      description: copy[locale].gettingStarted.testDesc,
      nameLocalizations: Object.fromEntries(
        locales.map((loc) => [loc, "test"]),
      ) as Record<SupportedLocale, string>,
      descriptionLocalizations: Object.fromEntries(
        locales.map((loc) => [loc, copy[loc].gettingStarted.testDesc]),
      ) as Record<SupportedLocale, string>,
      options: [],
      ephemeral: false,
    },
    {
      name: "challenge",
      description: copy[locale].gettingStarted.challengeDesc,
      nameLocalizations: Object.fromEntries(
        locales.map((loc) => [loc, "challenge"]),
      ) as Record<SupportedLocale, string>,
      descriptionLocalizations: Object.fromEntries(
        locales.map((loc) => [loc, copy[loc].gettingStarted.challengeDesc]),
      ) as Record<SupportedLocale, string>,
      options: [
        {
          name: "object",
          description: copy[locale].gettingStarted.challengeOptionDesc,
          nameLocalizations: Object.fromEntries(
            locales.map((loc) => [
              loc,
              copy[loc].gettingStarted.challengeOptionName,
            ]),
          ) as Record<SupportedLocale, string>,
          descriptionLocalizations: Object.fromEntries(
            locales.map((loc) => [
              loc,
              copy[loc].gettingStarted.challengeOptionDesc,
            ]),
          ) as Record<SupportedLocale, string>,
          type: "string",
          required: true,
          choices,
        },
      ],
      ephemeral: false,
    },
    {
      name: "feedback",
      description: copy[locale].gettingStarted.feedbackDesc,
      nameLocalizations: Object.fromEntries(
        locales.map((loc) => [loc, "feedback"]),
      ) as Record<SupportedLocale, string>,
      descriptionLocalizations: Object.fromEntries(
        locales.map((loc) => [loc, copy[loc].gettingStarted.feedbackDesc]),
      ) as Record<SupportedLocale, string>,
      options: [],
      ephemeral: true,
    },
  ];
}

export function buildAcceptChallengeComponents(
  locale: SupportedLocale,
  gameId: string,
): MessageActionRow[] {
  return [
    {
      type: ComponentType.ACTION_ROW,
      components: [
        {
          type: ComponentType.BUTTON,
          style: ButtonStyle.PRIMARY,
          customId: `accept_button_${gameId}`,
          label: copy[locale].gettingStarted.acceptButtonLabel,
        },
      ],
    },
  ];
}

export function buildRpsSelectComponents(
  locale: SupportedLocale,
  gameId: string,
): MessageActionRow[] {
  const rpsKeys: RpsObject[] = ["rock", "paper", "scissors"];
  const options: StringSelectOption[] = rpsKeys.map((key) => {
    const info = copy[locale].gettingStarted.rpsObjects[key];
    return {
      label: info.label,
      value: key,
      description: info.description,
      emoji: { name: info.emoji },
    };
  });
  return [
    {
      type: ComponentType.ACTION_ROW,
      components: [
        {
          type: ComponentType.STRING_SELECT,
          customId: `select_choice_${gameId}`,
          placeholder: copy[locale].gettingStarted.selectPlaceholder,
          options,
        },
      ],
    },
  ];
}

export function evaluateRpsResult(
  locale: SupportedLocale,
  p1Name: string,
  p1Choice: RpsObject,
  p2Name: string,
  p2Choice: RpsObject,
): string {
  const gs = copy[locale].gettingStarted;
  const c1Label = `${gs.rpsObjects[p1Choice].emoji} ${gs.rpsObjects[p1Choice].label}`;
  const c2Label = `${gs.rpsObjects[p2Choice].emoji} ${gs.rpsObjects[p2Choice].label}`;
  if (p1Choice === p2Choice) {
    return gs.rpsResultTie(p1Name, p2Name, c1Label);
  }
  const p1Wins =
    (p1Choice === "rock" && p2Choice === "scissors") ||
    (p1Choice === "paper" && p2Choice === "rock") ||
    (p1Choice === "scissors" && p2Choice === "paper");
  return p1Wins
    ? gs.rpsResultWin(p1Name, c1Label, p2Name, c2Label)
    : gs.rpsResultWin(p2Name, c2Label, p1Name, c1Label);
}

export function buildFeedbackModal(
  locale: SupportedLocale,
): InteractionModalData {
  const gs = copy[locale].gettingStarted;
  return {
    customId: "feedback_modal",
    title: gs.feedbackModalTitle,
    components: [
      {
        type: ComponentType.ACTION_ROW,
        components: [
          {
            type: ComponentType.TEXT_INPUT,
            customId: "subject",
            label: gs.feedbackSubjectLabel,
            style: TextInputStyle.SHORT,
            required: true,
            minLength: 1,
            maxLength: 100,
          },
        ],
      },
      {
        type: ComponentType.ACTION_ROW,
        components: [
          {
            type: ComponentType.TEXT_INPUT,
            customId: "details",
            label: gs.feedbackDetailsLabel,
            style: TextInputStyle.PARAGRAPH,
            required: false,
            maxLength: 500,
          },
        ],
      },
    ],
  };
}

export function parseCommand(text: string): CommandName | undefined {
  const name = text.trim().split(/\s+/, 1)[0]?.replace(/^\//, "").toLowerCase();
  return commandNames.find((candidate) => candidate === name);
}

export function fixedReply(
  locale: SupportedLocale,
  command: CommandName | undefined,
  historyCount: number,
  channelMention?: string,
): string {
  if (!command && channelMention) {
    return copy[locale].replies.channelMention(channelMention);
  }
  return copy[locale].replies[
    command === "context" && historyCount === 0
      ? "contextEmpty"
      : (command ?? "unknown")
  ];
}
