# AutoDL Manhua Pipeline

基于 [AutoDL.art ComfyUI API](https://autodl.art/docs/comfyui_api/) 的横屏漫剧成片流水线。默认分辨率 **768p横**。

姊妹项目 `zealman-pipeline` 负责面板侧定妆/静帧选型；本仓库负责托管 API 的多参考视频、首尾帧、对口型。

## 环境

```bash
cd C:\Users\Rjg\Projects\autodl-manhua-pipeline
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env   # 已写入 token 时可跳过
```

| 变量 | 含义 |
|---|---|
| `AUTODL_API_TOKEN` | 令牌管理 → 分组 **ComfyUI** |
| `DEFAULT_RESOLUTION` | 默认 `768p横` |
| `DEFAULT_WORKFLOW` | 默认 `manhua_video_ref` |

## 工作流别名

| 别名 | workflow_id | 用途 |
|---|---|---|
| `manhua_video_ref` | `minimax_h3_lightx2v_v5` | 多参考成片（主） |
| `manhua_video_ref_15s` | `minimax_h3_lightx2v_v5_15s` | 15s 多参考 |
| `manhua_video_ref_hq` | `minimax_h3_zm_u24` | 多图多音频升级画质 |
| `manhua_bridge` | `minimax_h3_lightx2v` | 首尾帧衔接 |
| `manhua_lipsync` | `minimax_h3_image_audio_to_video` | 对口型 |
| `manhua_video_t2v` | `minimax_h3_lightx2v_no_pic` | 文生预览（勿主链） |

规则全文：`docs/MANHUA_PIPELINE.md`。Cursor 规则：`.cursor/rules/`。

## 运行

```bash
# 单镜（参考图须为公网 URL）
python src/run_shot.py examples/shot_ref_video.json

# 项目包
python src/run_pipeline.py examples/manhua_demo/project.json
```

产物：`runs/<project_id>/`。

## 调用链

```text
ShotJob / project pack
  → style_lock + identity_lock
  → compile flat JSON body (resolution=768p横, ref_image_*)
  → POST /api/v1/comfyui/comfyui_workflow/{id}
  → poll result/{task_id}
  → download short-lived URLs
```
