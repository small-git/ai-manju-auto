# 漫剧完整流程（AutoDL.art API 版）

目标：横屏漫剧，默认分辨率 **768p横**。  
调用约定见 [ComfyUI API 文档](https://autodl.art/docs/comfyui_api/)：`POST .../comfyui_workflow/{id}` → 轮询 `result/{task_id}` → 尽快下载短时 URL。

## 一句话结论

**一致性主链用多图参考 H3（`minimax_h3_lightx2v_v5` / `zm_u24`），镜间用首尾帧（`minimax_h3_lightx2v`），对白用图+音频对口型；不要用纯文生视频当主链。定妆/静帧用外部生图（如 Zealman C19/C16），产物以公网 URL 喂给 AutoDL。**

## AutoDL 工作流映射（对标 Zealman 漫剧规则）

| 阶段 | 逻辑别名 | AutoDL workflow_id | Zealman 对标 |
|---|---|---|---|
| 定妆 / 分镜静帧 | （外部） | — | C19 / C16 / T10 |
| 成片（一致性） | `manhua_video_ref` | `minimax_h3_lightx2v_v5` | U06 |
| 成片 15s | `manhua_video_ref_15s` | `minimax_h3_lightx2v_v5_15s` | — |
| 成片+音频 HQ | `manhua_video_ref_hq` | `minimax_h3_zm_u24` | U24 |
| 镜间衔接 | `manhua_bridge` | `minimax_h3_lightx2v` | G02 同类 |
| 对口型 | `manhua_lipsync` | `minimax_h3_image_audio_to_video` | U11 |
| 纯文生（仅预览） | `manhua_video_t2v` | `minimax_h3_lightx2v_no_pic` | U03（不推荐主链） |

### 明确不推荐作漫剧主链

- 纯文生视频（无参考图）→ 人物漂移
- 二次元转真人类洗图 → 破坏漫剧画风
- 默认负向含 cartoon 的写实向视频流

## 完整流水线

```text
StoryPack（schemas/story_pack.json）
  script.logline / synopsis / episodes.beats     ← 故事真相
  characters[].identity_lock + sheet/ref URLs    ← 人物冻结
  environments[].scene_card + establishing URL   ← 环境冻结
  shots[].action / camera / state                ← 单镜只改动作运镜
        ↓ expand_story_pack()
  ShotJob[]（身份锁 + 画风锁 + ref_images 自动组装）
        ↓
  [外部] 定妆/静帧 URL 齐备后
  → [v5 / zm_u24] 多参考成片（768p横）→ clips/
  → [lightx2v] bridge_from 镜用首尾帧修缝
  → （可选）needs_lipsync 对口型
  → 拼接 / 字幕 / 导出
```

示例：`examples/manhua_demo/story_pack.json`（E01 三镜：入画 → 望河 → 决意）。

```bash
python src/run_pipeline.py examples/manhua_demo/story_pack.json --validate-only
python src/run_pipeline.py examples/manhua_demo/story_pack.json --expand-only
python src/run_pipeline.py examples/manhua_demo/story_pack.json --shots E01_S01_SH03
```

## 提示词与一致性

1. 全链路同一画风锁（`templates/style_locks/`）+ 人物 `identity_lock`，单镜只改 `action` 与运镜  
2. 每张参考图只负责一件事：脸 / 全身 / 服装 / 场景  
3. `ref_image_0` 必填；未用槽位不要传空串  
4. 结果 URL 有效期短，成功后立即下载到 `runs/`

## 工作台 P0–P3（`dsh-manhua`）

启动：`dsh-manhua/workbench.cmd` → http://127.0.0.1:3780

| 优先级 | 能力 | 落点 |
|---|---|---|
| **P0** | `props[]` + `prop_ids`；齐套门闸；计划预审；跳过已有 + 重试 | `story.ts` / `production/gate.ts` / `plan.ts` / `retry.ts` |
| **P1** | 静帧/成片版本；九宫格选格；定妆/静帧审批；H3 九分节预览 | `production/versions.ts` / `prompt.ts` + 工作台 UI |
| **P2** | TTS → lipsync；自动 bridge；ZIP；时间线 JSON；章节流水线 | `providers/tts.ts` / `autodl.ts` / `export_bundle.ts` |
| **P3** | LLM 拆剧草稿；Provider 热切换；画风锁列表；画布镜头卡 | `providers/llm.ts` / `registry.ts` + 画布模块 |

成片前硬拦：出场角色公网 sheet + 已批准；道具公网 sheet；静帧或环境 establishing；无空串 ref。

## 开源项目对照（完整漫剧规则同源）

| 项目 | 价值 | 链接 |
|---|---|---|
| **ArcReel** | 资产先于镜头、线索追踪、宫格首尾帧 | https://github.com/ArcReel/ArcReel |
| **alibaba/lumenx** | 剧本→分镜→资产→视频→合成一站式 Studio | https://github.com/alibaba/lumenx |
| **LocalMiniDrama** | 本地流水线、跳过已有、工程 ZIP | https://github.com/xuanyustudio/LocalMiniDrama |
| **oskey/Go-Ai-Studio** | 剧集/配音/本地 ComfyUI 生产编排 | https://github.com/oskey/Go-Ai-Studio |
| **本仓库姊妹** `zealman-pipeline` | 面板侧定妆/静帧选型与 ShotJob 账本 | `~/Projects/zealman-pipeline` |

本仓库专注 **AutoDL 托管 API 成片段** + **dsh-manhua 工作台编排**；定妆静帧可用 GPT/Gemini 或外部面板，产物以公网 URL 喂给 AutoDL。
