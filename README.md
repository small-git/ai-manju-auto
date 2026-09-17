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
| `manhua_tts` | `indextts2-v1` | IndexTTS2 配音（对白→音频） |

## 运行

```bash
# 校验 / 展开完整剧情包（只读，可不带 --story）
python src/run_pipeline.py examples/manhua_demo/story_pack.json --validate-only
python src/run_pipeline.py examples/manhua_demo/story_pack.json --expand-only

# 成片必须显式 --story（一故事一剧本，防串戏硬门禁）
python src/run_pipeline.py --story manhua_demo                      # 全镜成片
python src/run_pipeline.py --story manhua_demo --shots E01_S01_SH03 # 只跑其中一镜

# 断点续跑：默认跳过已有成功产物；--force 全部重跑
python src/run_pipeline.py --story manhua_demo --retries 2          # 失败指数退避重试
python src/run_pipeline.py --story manhua_demo --keep-going         # 单镜失败不中断（退出码 3）
python src/run_pipeline.py --story manhua_demo --force              # 忽略已有产物重跑

# 步骤与并发（默认并发：全部提交后统一轮询；--serial 强制串行）
python src/run_pipeline.py --story manhua_demo --steps audio,video,bridge,lipsync
python src/run_pipeline.py --story manhua_demo --serial

# 批量补齐定妆/静帧资产（Qwen-Image 生图并回填公网 URL）
python src/gen_story_assets.py --story manhua_demo --assets

# 单镜 ShotJob
python src/run_shot.py examples/shot_ref_video.json
```

## 流水线阶段

```text
audio   TTS 配音：dialogue → 02_audio/（音色参考 characters[].voice_ref；产物 URL 自动链接给 lipsync）
video   多参考成片 → 03_video/（成片前硬拦：characters.approved / shots.still_approved 未批准拒跑）
bridge  镜间首尾帧 → 04_bridge/（缺省由相邻镜 still_url 派生）
lipsync needs_lipsync 镜对口型 → 05_lipsync/
export  自动导出 04_export/CH0x_timeline.json + CH0x.srt → scripts/export_jianying_draft.py 生成剪映草稿
```

报告：`pipeline_report.json` 含 `summary` 聚合（成功/失败/续跑跳过/API 耗时/产物数）与 `failures` 明细；校验时输出 state 连续性警告（不阻断）。

## 章节管理

- 默认章：`stories/<story_id>/story.json`；更多章节放 `stories/<story_id>/chapters/<CHAPTER_ID>.json`。
- 工作台「故事管理 → 章节管理」：新建章节（克隆人物/环境/道具宇宙，剧本分镜独立，draft 待填充）、进入章节、宇宙同步（当前章资产 → 其余章）。
- 后续流程（定妆/分镜/门闸/成片/出片）全部按 `(story_id, chapter_id)` 寻址；产物目录天然章节隔离 `runs/<story_id>/<chapter_id>/`。
- CLI：`python src/run_pipeline.py --story <id> --chapter CH02 ...`（缺省为默认章）。
- draft 章节（空分镜）可被工作台打开编辑，但过不了成片校验；填充分镜后删除 `draft` 即转正。
- `stories/index.json` 为故事→章节两级索引（顶层字段保留为最近注册章，兼容旧消费方）。

产物：`runs/<story_id>/<chapter_id>/`（含 `expanded_shot_jobs.json`、`pipeline_report.json`）。

> 成片前置：出场 `characters`/`props` 的 `ref_images` 与各镜 `still_url` 必须是**公网 URL**（本地文件不被 AutoDL 接受）。可用 `python src/gen_story_assets.py --story <id> --shot <shot_id> [--also-sheet]` 生图并自动回填；Bridge 首尾帧缺省时自动由相邻镜 `still_url` 派生。

## 调用链

```text
StoryPack
  → expand（身份锁 + 画风锁 + ref 组装）
  → ShotJob[]
  → POST /api/v1/comfyui/comfyui_workflow/{id}
  → poll result/{task_id}
  → download short-lived URLs
```
