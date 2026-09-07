type BranchStatus = "waiting" | "running" | "complete" | "failed" | "skipped";
interface Branch {
  status: BranchStatus;
  progress: number;
  completedChunks?: number;
  totalChunks?: number;
}

export default function AnalysisProgress({ stages, stageIndex, branches }: {
  stages: string[];
  stageIndex: number;
  branches: Record<"summary" | "transcript", Branch>;
}) {
  const split = stages[3] === "字幕识别与视频总结";
  return (
    <ol className={`stage-list${split ? " split" : ""}`} aria-label="视频处理进度">
      {stages.map((stage, index) => {
        if (split && index === 3) return (
          <li className="analysis-fork" key={stage}>
            {(["transcript", "summary"] as const).map((key) => {
              const branch = branches[key];
              const label = key === "transcript" ? "Qwen 在线识别字幕" : "Qwen 理解画面与声音";
              const chunkStatus = key === "transcript" && branch.totalChunks
                ? `已识别 ${branch.completedChunks ?? 0}/${branch.totalChunks} 个音频分片`
                : null;
              const status = branch.status === "complete" ? chunkStatus ?? "已完成"
                : branch.status === "failed" ? `${chunkStatus ? `${chunkStatus} · ` : ""}失败，保留另一路结果`
                : branch.status === "running" ? chunkStatus ?? (key === "transcript" ? "正在准备音频分片" : `处理中 · 预计 ${Math.round(branch.progress * 100)}%`)
                : "等待中";
              return (
                <div className={`analysis-branch ${branch.status}`} key={key} aria-label={`${label}：${status}`}>
                  <span className="stage-mark" aria-hidden="true">{branch.status === "complete" ? "✓" : branch.status === "failed" ? "!" : key === "transcript" ? "字" : "影"}</span>
                  <strong>{label}</strong>
                  <small>{status}</small>
                  <span className="branch-progress-track" aria-hidden="true"><span style={{ width: `${branch.progress * 100}%` }} /></span>
                </div>
              );
            })}
          </li>
        );
        const complete = index < stageIndex;
        return (
          <li key={stage} className={complete ? "complete" : index === stageIndex ? "active" : ""}>
            <span className="stage-mark" aria-hidden="true">{complete ? "✓" : index + 1}</span>
            <div><strong>{stage}</strong><small>{complete ? "已完成" : index === stageIndex ? "正在处理" : "等待中"}</small></div>
          </li>
        );
      })}
    </ol>
  );
}
