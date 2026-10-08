# 微信读书与阅读资料

人生看板、阅读和思考运行在同一份个人工作台中。GitHub Pages 发布免费静态网页；生活线索、经历、回顾、书架、笔记、统计和思考保存在当前浏览器。可选的微信读书同步由 GitHub Actions 读取，仅发布加密阅读快照，网页解锁预览后再决定保存；人生看板、独立思考、事务与完整备份不发布。手机和电脑各自保存，通过完整 JSON 备份交换资料。

## 留下阅读，也给思考留空间

- **人生看板首页**：记录兴趣、牵挂、疑问与方向这些生活线索，留下某天的经历、感受和发现。回顾时问问自己：最近注意到了什么、什么正在变化、有什么想继续保留。线索与经历可以按需关联，已有待办仍保留在事务模块中。
- **阅读**：手动添加书籍，或预览导入书架、划线和本人想法；按书名、作者、类型、状态筛选。统计有每日明细时显示年度热力图，有单书阅读时长时显示投入时间最多的书，帮助回看阅读兴趣与习惯。
- **书籍详情**：分别查看划线原文与本人想法，可以只留痕、回看，也可以用「写一段思考」带入书籍、原摘录和本人想法，检查后保存。
- **思考**：自由记录、编辑、搜索与删除自己的感受、疑问和判断，关联书籍和原摘录可选，允许先留下尚未想透的问题。
- **事务工具**：阅读的「安排阅读」「把摘录变成行动」和思考的「转为待办」放在默认关闭的折叠入口里。需要处理具体事情时再打开待办草稿，确认后保存。

默认书架与思考为空。页面中的格式样例只在点击后出现，预览和保存分开，不会预先填入个人记录。

## 通过 GitHub 同步微信读书

打开「阅读 → 微信读书同步」。首次需要在仓库的 **Actions Secrets** 设置 `WEREAD_API_KEY` 和 `WEREAD_SYNC_PASSPHRASE`，再运行 **Publish GitHub Pages** 工作流。前者用于 Actions 访问微信读书，后者用于加密阅读快照；API Key 不输入网页。详细步骤见 [GitHub 微信读书同步](GITHUB_READING_SYNC.md)。

Actions 读取官方书架、累计统计及今年的每日统计，定时每天两次，也可手动运行；笔记读取默认关闭，手动运行时可以勾选。服务器只把加密阅读快照与不含个人资料的状态文件发布到 Pages。网页填写「同步资料解锁口令」，点击「读取同步资料」，在当前浏览器解密并检查；「保存到阅读」才合并，也可以放弃预览。

解锁口令在读取开始、关闭或离开页面时清除，不写入浏览器存储、备份或构建文件。公开站点可下载密文，因此请使用独立的随机长口令。加密快照不是完整工作台备份，不包含人生看板、独立思考或事务。

每次官方请求使用技能版本 `1.0.4`，业务参数平铺在 JSON 顶层。接口返回 `upgrade_info` 时立即停止。读取失败不发布半份资料，可能保留上一份加密快照并标明更新失败。笔记本目录上限为 **1000 本**，超过时提示 `notebook_limit_exceeded`；划线与本人想法内容总量上限为 **10000 条**，超过时提示 `note_limit_exceeded`。官方明确给出某类内容数量为 0 时跳过对应内容接口，数量未知时仍读取核实。超出任一上限时可取消笔记读取，仅获取书架与统计，或按阅读 JSON 格式分批导入。加密快照仍限制在 20 MB 以内，完整读取和校验成功后才发布。

此前以 `https://templehao.github.io` 为来源发送官方接口 OPTIONS 预检得到 HTTP 401，响应只允许 `https://weread.qq.com`，因此网页已改为只读取本站文件。Actions 运行在服务器上，不受这一浏览器规则限制。尚需使用者配置仓库 Secret 并运行真实工作流；模拟官方响应和加密解密测试不代表个人授权及真实资料读取已经成功。未配置或同步失败时仍可使用下面的 JSON 导入。

## 阅读 JSON 导入

在「阅读 → 导入阅读 JSON」选择文件或粘贴 JSON，点击「预览资料」，核对后「确认导入」。同一编号的新资料会更新旧资料；其他书籍与笔记保留。新统计非空时更新当前统计，未提供统计时保留已有统计。每日历史按日期合并，同日采用新值；更新今年资料不会移除之前导入的年度日记录。

以下是**格式示例**，全部为占位内容，请替换后再导入：

```json
{
  "version": 1,
  "source": "manual",
  "items": [
    {
      "id": "your-book-id",
      "title": "替换为你的书名",
      "author": "作者",
      "kind": "ebook",
      "status": "reading",
      "progress": 35,
      "lastReadAt": "2026-10-07",
      "secondsRead": 7200
    }
  ],
  "highlights": [
    {
      "id": "your-highlight-id",
      "bookId": "your-book-id",
      "text": "替换为想留下的原文",
      "thought": "替换为你自己的想法",
      "chapter": "章节名称",
      "createdAt": "2026-10-07"
    },
    {
      "id": "your-review-id",
      "bookId": "your-book-id",
      "text": "",
      "thought": "没有对应划线原文的整本书想法，也可以单独保存"
    }
  ],
  "stats": {
    "totalSeconds": 7200,
    "readingDays": 2,
    "dailySeconds": [
      { "date": "2026-10-06", "seconds": 1800 },
      { "date": "2026-10-07", "seconds": 5400 }
    ],
    "mode": "monthly",
    "period": null,
    "preferredHours": [
      { "hour": 21, "seconds": 1800 }
    ]
  },
  "syncedAt": "2026-10-07T12:00:00+08:00"
}
```

顶层 `version`、`source`、`items` 必填。`source` 为 `manual` 或 `weread`；它标识来源，不代表应用已经验证账号。`highlights` 可省略，默认为空；`stats`、`syncedAt` 可省略，默认为 `null`。阅读页「导出阅读」生成内部规范的 `books` 数组形态，也可直接重新导入。

| 字段 | 格式与含义 |
| --- | --- |
| 书籍 `id`、`title`、`author` | 必填；编号唯一，书名非空。作者未知时填写空字符串。 |
| `kind` | `ebook` 电子书、`audiobook` 有声书/专辑、`article` 文章或文章收藏入口。 |
| `status` | `wanted` 想读、`reading` 在读、`finished` 已读完；表示自己的阅读状态。 |
| `progress` | 可选，`0–100` 百分比；`1` 表示 **1%**。 |
| `secondsRead` | 可选，本书阅读时长，单位**秒**。 |
| `lastReadAt`、笔记 `createdAt` | 可选，实际存在的 `YYYY-MM-DD`，或带时区的 ISO 时间；相对日期不能直接导入。 |
| 笔记 `id`、`bookId` | 必填；笔记编号唯一，`bookId` 必须对应本次文件中的书籍 `id`。 |
| 笔记 `text`、`thought` | `text` 必填，可为空；原文与想法至少一项非空。不带原文的个人书评用空 `text` 和非空 `thought`。 |
| `deepLink`、`cover` | 可选；链接仅接受绝对 HTTPS 或 `weread://`。封面使用 HTTPS；已确认的腾讯官方封面域名提供的旧 HTTP 地址会转换为 HTTPS。图片支持 `qq.com`、`qpic.cn` 及微信读书专用 `wfqqreader-1252317822.image.myqcloud.com`；加载失败时可重试。界面只提供微信读书官方域名或 `weread://` 的打开入口，不自行拼接链接。 |
| `stats.totalSeconds` | 该统计范围的总阅读/收听秒数。 |
| `stats.readingDays` | 可选，有效阅读天数；未知时省略，不能用 `0` 代替未知。 |
| `stats.dailySeconds` | 每项包含唯一日期与秒数；缺少某天记录表示未知，不代表当天没读。 |
| `stats.mode` | `weekly` 自然周、`monthly` 自然月、`annually` 自然年、`overall` 全部历史。 |
| `stats.period` | 必填，可为 `null`；有实际服务端周期信息时为 `{ "start": "YYYY-MM-DD" 或 null, "baseTime": Unix秒数 }`。 |
| `stats.preferredHours` | 可选，实际钟点 `hour: 0–23` 与阅读秒数，最多 24 项；无数据时省略。 |
| `syncedAt` | 带时区的 ISO 时间，或 `null`。 |

当前解析最多接收 10000 个书籍条目、30000 条笔记，粘贴文本最多 2000000 个字符。浏览器可用存储空间可能更小；保存失败会保留已有记录。导入 JSON 经过严格校验，不接受未经整理的接口原始回包、重复编号、无关联书籍的笔记或 `javascript:`、`data:`、相对链接。

## 统计口径

所有数值阅读/收听时长使用**秒**，显示时转换为小时和分钟。官方 `totalReadTime` 是总量依据，不用可能截断的 `readTimes` 明细求和替代它。微信读书同步保留累计总时长与有效日数，同时读取今年的年度日明细；因此累计卡片和年度热力图的范围不同。

热力图的年度时长只汇总该年**已导入的日明细**，空白日期标为未导入；「有阅读」表示这天秒数大于零。官方有效阅读天数 `readDays` 按单日满一分钟计算，这两个天数可能不同。

`readTimes` 在周/月模式通常按天分桶，在年度模式按月、累计模式按年，不能把年/月分桶画成每日记录。年度日历只读取明确的 `dailyReadTimes`。日期按用户的 `Asia/Shanghai` 时区显示，周期起点使用服务端实际返回的 `baseTime`；`overall` 的 `0` 表示全部历史，不解释为 1970 年开始。

书架和笔记的数量也采用各自口径：

| 指标 | 口径 |
| --- | --- |
| 官方可见书架条目数 | `books.length + albums.length + (mp 非空 ? 1 : 0)`。`bookCount` 只计电子书。 |
| 有声书/专辑 | 取 `albums`，与电子书独立；专辑 `finish`/「已完结」表示内容更新完结，不表示自己听完。 |
| 文章收藏 | 非空 `mp` 计一个目录入口，不包含具体文章内容。 |
| 应用当前书架 | 所有已保存条目，可能含手动添加、保留的旧资料、笔记或排行涉及的书籍，不能等同于当前官方书架数量。 |
| 官方笔记总数 | `noteCount + reviewCount + bookmarkCount`；`noteCount` 是划线数，`reviewCount` 已包含个人点评。 |
| 本次可取回笔记内容 | 划线和本人想法/点评；书签只有数量，当前官方接口不提供书签内容。 |
| 本页划线/本人想法标签 | 根据实际已保存的非空原文/想法展示；不等同于官方含书签的笔记总数。 |

笔记本概览的 `readingProgress` 未声明单位，当前不将它猜成百分比。只有官方 `/book/getprogress` 的 `progress` 明确为 `0–100`。偏好时段原始 `preferTime` 从 **6 点**开始，转换后才使用 `0–23` 的实际钟点。

## 完整备份与跨设备移交

阅读页「导出阅读」只包含阅读资料。页脚「导出备份」生成 `life-workbench-backup` **v2**，包含人生看板的线索、经历感受与发现、回顾，以及待办、原文、书架、划线与本人想法、阅读统计和独立思考。人生看板位于 `life.board`，保留记录之间的关联编号；备份中的 `life.reading` 仍为阅读库 `version: 1`，阅读库版本和完整备份版本属于不同格式。

在另一台设备打开相同网页，使用「恢复备份」导入。仍支持原有 **v1** 待办备份，恢复 v1 会保留已有看板、阅读和思考。旧数据或旧 v2 备份没有 `life.board` 时按空看板读取；更新阅读与思考、恢复旧备份会保留已有看板，也会保留原有待办。完整备份恢复只补回缺少的记录；相同编号内容或已有阅读统计冲突时，整次恢复失败，当前资料不变。这与阅读 JSON 导入的“相同编号更新”规则不同。

恢复文件最多 20 MB。请把私密备份保存在自己控制的位置，不提交到公开仓库。清除网站数据会删除当前浏览器中的人生看板、待办、原文、阅读和思考；已下载的备份保留。应用没有账号、自动跨设备同步或定时备份。

## 官方技能与后续迭代

本开发环境已安装并阅读 [腾讯官方 WeChatReading 技能](https://github.com/Tencent/WeChatReading)，本次采用 [SKILL.md 1.0.4](https://github.com/Tencent/WeChatReading/blob/main/skills/SKILL.md) 的接口与能力说明。在其他支持该技能的 Agent 环境中，可使用用户提供的安装命令：

```sh
npx skills add Tencent/WeChatReading -g
```

该命令安装 Agent 技能，不会使 GitHub Pages 网页自动获得授权或解除浏览器跨域限制。当前服务端同步按这些官方接口约定读取；个人 API Key 由使用者配置到 GitHub Secrets，不进入源代码或发布文件，真实授权仍需工作流验证。官方字段说明见 [书架](https://github.com/Tencent/WeChatReading/blob/main/skills/shelf.md)、[阅读统计](https://github.com/Tencent/WeChatReading/blob/main/skills/readdata.md)、[笔记](https://github.com/Tencent/WeChatReading/blob/main/skills/notes.md)、[书籍与进度](https://github.com/Tencent/WeChatReading/blob/main/skills/book.md)。

当前已实现人生看板、每日记录热力图、书架、划线与想法、独立思考及可选事务工具。截图中的阅读年轮尚未实现；微信读书同步只取今年日明细，尚无多年度历史自动查询。按现有导入资料选择年份不代表历史已经取全。偏好时段可展示，分类、作者、出版社等完整偏好画像尚未实现。后续先完成个人账号的真实工作流验证，再逐步完善历史资料、年轮和偏好分析。

产品原则见 [人生看板的产品方向](PRODUCT_DIRECTION.md)，免费发布步骤见 [GitHub Pages 发布指南](GITHUB_PAGES.md)，事务的聊天收集约定见 [CHAT_CAPTURE.md](CHAT_CAPTURE.md)。
