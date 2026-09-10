# AutoDL Manhua Pipeline

基于 [AutoDL.art ComfyUI API](https://autodl.art/docs/comfyui_api/) 的横屏漫剧流水线。默认分辨率 **768p横**。

路径：`D:\Projects\autodl-manhua-pipeline`  
姊妹项目 `zealman-pipeline` 负责面板侧定妆/静帧；本仓库负责 **StoryPack 上游账本 + 托管 API 成片**。

## 环境

```bash
cd D:\Projects\autodl-manhua-pipeline
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

| 变量 | 含义 |
|---|---|
| `AUTODL_API_TOKEN` | 令牌管理 → 分组 **ComfyUI** |
| `DEFAULT_RESOLUTION` | 默认 `768p横` |
| `DEFAULT_WORKFLOW` | 默认 `manhua_video_ref` |

## StoryPack（完整剧情）

优先级：`剧本 → 人物 → 环境 → 分镜`。Schema：`schemas/story_pack.json`。

| 字段 | 作用 |
|---|---|
| `script` | logline / synopsis / beats（故事真相） |
| `characters` | `identity_lock` 跨镜冻结 + 定妆 URL |
| `environments` | `scene_card` 稳定场景 + 空镜 URL |
| `shots` | 只写 `action` / 运镜 / 情绪 / `state` |

## 工作流别名

| 别名 | workflow_id | 用途 |
|---|---|---|
| `manhua_video_ref` | `minimax_h3_lightx2v_v5` | 多参考成片（主） |
| `manhua_video_ref_15s` | `minimax_h3_lightx2v_v5_15s` | 15s 多参考 |
| `manhua_video_ref_hq` | `minimax_h3_zm_u24` | 多图多音频升级画质 |
| `manhua_bridge` | `minimax_h3_lightx2v` | 首尾帧衔接 |
| `manhua_lipsync` | `minimax_h3_image_audio_to_video` | 对口型 |
| `manhua_video_t2v` | `minimax_h3_lightx2v_no_pic` | 文生预览（勿主链） |

## 运行

```bash
# 校验 / 展开完整剧情包
python src/run_pipeline.py examples/manhua_demo/story_pack.json --validate-only
python src/run_pipeline.py examples/manhua_demo/story_pack.json --expand-only

# 只跑其中一镜
python src/run_pipeline.py examples/manhua_demo/story_pack.json --shots E01_S01_SH03

# 单镜 ShotJob
python src/run_shot.py examples/shot_ref_video.json
```

产物：`runs/<project_id>/`（含 `expanded_shot_jobs.json`）。

## 调用链

```text
StoryPack
  → expand（身份锁 + 画风锁 + ref 组装）
  → ShotJob[]
  → POST /api/v1/comfyui/comfyui_workflow/{id}
  → poll result/{task_id}
  → download short-lived URLs
```
