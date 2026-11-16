# Ciel 正式环境测试记录

- 日期：2026-11-06，Asia/Shanghai。
- 站点：`https://tescord.terata.top`；Bot：`Ciel`，application `cmw2c1yvy005tnx3keu87fv23`。
- 程序：`scripts/fixed-bot.ts`；本机后台运行，PID 以 `.runtime/fixed-bot/status.json` 为准。未安装开机启动服务。
- 线上操作：注册一个设备和四个指令；通过现有登录账号在 Ciel 私信中发送测试内容。未修改频道配置或业务数据库，未发布主站代码。
- 上下文：保留线上默认值 5，日志实测数量 `2 → 4 → 5 → 5`；测试标记在窗口内为 `markerFound=true`，移出最近 5 条后为 `false`。

| 执行项                                                                      | 最终结果                            | 凭据                                                            |
| --------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| `pnpm typecheck`                                                            | exit 0                              | `test-results/fixed-bot-production-20261106/typecheck.log`      |
| `pnpm build`                                                                | exit 0                              | `test-results/fixed-bot-production-20261106/build.log`          |
| `pnpm test`                                                                 | 5 文件，22/22 通过                  | `test-results/fixed-bot-production-20261106/unit.log`           |
| `pnpm verify:protocol`                                                      | SHA256 通过                         | `test-results/fixed-bot-production-20261106/protocol.log`       |
| `e2e/fixed-bot.production.cua.js`，CUA Playwright API，现有 Chrome 登录会话 | 8/8 通过，捕获的 Console Error 为 0 | `test-results/fixed-bot-production-20261106/playwright-ui.json` |
| 后台重复启动                                                                | 返回现有 PID，不另建实例            | `pnpm start:test-bot:background`                                |
| 停止后重新启动                                                              | 复用设备，READY 成功                | `test-results/fixed-bot-production-20261106/events.jsonl`       |

Playwright 用例：加密私信触发、文本 `ping` / `hello` / `help`、原生 `/ping` / `/hello` / `/help` / `/context`。脚本使用已绑定且打开 Ciel 私信的 `liveTab`，在 CUA JavaScript 会话执行，等待新消息或新的私密响应出现。未导出用户登录凭据。

初次探索中 `/context` 的确认请求出现一次 `TRANSPORT_ERROR`。测试程序补充了仅针对确认请求的一次幂等重试，并补齐单元测试；最终完整 8 项线上验收通过，重启后的运行错误数为 0。历史错误保留在事件日志中。另有一次新增测试将错误码写成字符串而导致类型检查失败，改用共享 `ErrorCode` 后最终检查通过。

凭据还包括 `production-ui.jpg` 和 `status.json`。Token 位于忽略的 `.env.production.local`，密钥位于忽略的 `.runtime/`；凭据日志只记录事件 ID、数量与布尔结果。测试消息保留在 Ciel 私信中，便于继续测试。

未验证范围：本轮线上用例集中于加密私信；频道提及／引用触发、其他浏览器、五语言界面切换、封禁／撤销等完整线上负向矩阵没有执行。五语言指令定义通过共享协议校验。页面已有的加密引用预览显示部分密文 JSON、私密响应布局问题未在本轮修改。本记录只代表固定回复测试程序的专项验收。
