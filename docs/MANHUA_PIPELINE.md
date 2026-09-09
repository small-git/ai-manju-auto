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
故事大纲
  → 剧本 + C/S/P 编号 + 画风锁（统一前缀）
  → [外部] 角色定妆三视图 → 上传得到公网 URL → characters/
  → [外部] 每镜静帧（身份句 + 场景卡 + 画风锁）→ stills/
  → [v5 / zm_u24] 多参考成片（定妆+静帧填满 ref 槽，resolution=768p横）→ clips/
  → [lightx2v] 需要硬切连续的镜头用首尾帧修缝
  → （可选）[image_audio] 对白镜头对口型
  → 拼接 / 字幕 / 导出
```

## 提示词与一致性

1. 全链路同一画风锁（`templates/style_locks/`）+ 身份锁句，单镜只改动作与运镜  
2. 每张参考图只负责一件事：脸 / 全身 / 服装 / 场景  
3. `ref_image_0` 必填；未用槽位不要传空串  
4. 结果 URL 有效期短，成功后立即下载到 `runs/`

## 开源项目对照（完整漫剧规则同源）

| 项目 | 价值 | 链接 |
|---|---|---|
| **alibaba/lumenx** | 剧本→分镜→资产→视频→合成一站式 Studio | https://github.com/alibaba/lumenx |
| **oskey/Go-Ai-Studio** | 剧集/配音/本地 ComfyUI 生产编排 | https://github.com/oskey/Go-Ai-Studio |
| **oskey/kt-ai-Studio** | LLM + ComfyUI 漫剧批量（旧版） | https://github.com/oskey/kt-ai-Studio |
| **本仓库姊妹** `zealman-pipeline` | 面板侧定妆/静帧选型与 ShotJob 账本 | `~/Projects/zealman-pipeline` |

本仓库专注 **AutoDL 托管 API 成片段**；定妆静帧可继续用 Zealman，或日后接入其它图生 API。
