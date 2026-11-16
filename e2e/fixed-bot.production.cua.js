var cielProductionCases = [];
var cielWait = async (locator) => {
  let failure;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await locator.waitFor({ state: "visible", timeoutMs: 10000 });
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
};
for (var item of [
  {
    input: "nekord-test-context-20261106",
    reply: "消息已收到。输入 /help 查看测试指令。",
    test: "encrypted DM trigger",
  },
  { input: "ping", reply: "Pong!", test: "encrypted text ping" },
  {
    input: "hello",
    reply: "你好，我是 Ciel 测试 Bot。",
    test: "encrypted text hello",
  },
  {
    input: "help",
    reply: "可用指令：/ping、/hello、/help、/context。",
    test: "encrypted text help",
  },
]) {
  var replies = liveTab.playwright
    .getByTestId("message-content")
    .filter({ hasText: item.reply });
  var before = await replies.count();
  await liveTab.playwright.getByTestId("chat-mention-input").fill(item.input);
  await liveTab.playwright.getByTestId("chat-mention-input").press("Enter");
  await cielWait(replies.nth(before));
  cielProductionCases.push({ test: item.test, status: "PASS" });
}
for (var item of [
  { option: "/ping 测试连接", reply: "Pong!", test: "encrypted native /ping" },
  {
    option: "/hello 发送固定问候",
    reply: "你好，我是 Ciel 测试 Bot。",
    test: "encrypted native /hello",
  },
  {
    option: "/help 查看测试指令",
    reply: "可用指令：/ping、/hello、/help、/context。",
    test: "encrypted native /help",
  },
  {
    option: "/context 测试上下文读取",
    reply: "上下文读取成功。",
    test: "encrypted native /context",
  },
]) {
  var replies = liveTab.playwright
    .getByRole("article")
    .filter({ hasText: item.reply });
  var before = await replies.count();
  await liveTab.playwright.getByTestId("chat-mention-input").fill("/");
  var option = liveTab.playwright.getByRole("option", {
    name: item.option,
    exact: true,
  });
  await cielWait(option);
  await option.click();
  await cielWait(replies.nth(before));
  cielProductionCases.push({ test: item.test, status: "PASS" });
}
nodeRepl.write(cielProductionCases);
