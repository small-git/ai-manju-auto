# 漫剧工作台（P0–P3）

本地中文**生产台**：StoryPack 账本 + 齐套门闸 + 计划预审 + 版本抽卡 + AutoDL 成片。

## 模块

| 模块 | 能力 |
|---|---|
| 密钥管理 | AutoDL / OpenAI / Gemini；中转站；模型；连通测试 |
| **文案工作室** | 主线/小说导入 → 续写/反转/改写 → 采用正文 → 写回 synopsis / **拆下一集分镜** |
| 故事管理 | 故事列表、画风锁、LLM 拆剧草稿 |
| 定妆管理 | 生成 sheet、审批门闸 |
| 道具管理 | `props[]` 线索锁 + 公网 URL（`assembleRefs` 自动注入） |
| 分镜管理 | 静帧 / **九宫格** / 裁切选格 / 版本对比 / 审批 |
| 计划预审 | `video_ref` / `bridge` / `grid` / `lipsync`；自动 Bridge；H3 九分节预览 |
| 成片管理 | 齐套红灯拦截、跳过已有、失败重试、章节流水线、TTS |
| 画布编排 | 镜头卡一览（账本仍是 StoryPack） |
| 出片 / 交付 | ffmpeg 成章、时间线 JSON、工程 ZIP 导入导出 |

## 启动

```bat
cd /d D:\Projects\autodl-manhua-pipeline\dsh-manhua
workbench.cmd
```

浏览器：**http://127.0.0.1:3780**

CLI 工具箱（可选）：

```bat
toolbox.cmd
```

## 推荐流程

1. 进入故事（或 LLM 拆剧生成草稿后人工审阅）
2. 密钥 + CDN 前缀配齐（成片需要公网 URL）
3. 定妆 → **批准**；道具填公网 sheet
4. 分镜静帧 / 九宫格选格 → **批准**
5. 计划预审（可点「自动 Bridge」）
6. 成片：齐套灯绿才可跑；「补全并生成」跳过已有
7. 有对白：TTS → lipsync 路径
8. 出片 / 导出时间线 / ZIP 备份

## 目录约定

```text
stories/<story_id>/story.json
runs/<story_id>/<chapter_id>/
  01_assets/          定妆、静帧、九宫格与版本
  02_audio/           TTS
  03_video/<shot_id>/v01.mp4 …
  04_export/          成章、timeline.json、ZIP
  manifest.json       选用版本账本
```

## 规则（与仓库主链一致）

- 一故事一宇宙；禁止无 `story_id` 成片
- 主链：多图参考 H3，不用纯文生做人设主生成
- 单镜只改 `action` / 运镜，不改 `identity_lock` / `clue_lock`
- 空字符串禁止占 ref 槽
