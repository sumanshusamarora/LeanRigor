import type { ExecutionGraph } from "./types.js";

export interface CommitProposal {
  message: string;
  files: string[];
  taskIds: string[];
}

export function proposeCommits(graph: ExecutionGraph): CommitProposal[] {
  return graph.tasks
    .filter((task) => task.writes.length > 0)
    .map((task) => ({
      message: conventionalMessage(task.objective),
      files: [...task.writes],
      taskIds: [task.id]
    }));
}

function conventionalMessage(objective: string): string {
  const normalised = objective.trim().replace(/[.!]+$/, "");
  const lower = normalised.charAt(0).toLowerCase() + normalised.slice(1);
  return `feat: ${lower}`;
}

export function commitCommands(proposal: CommitProposal): string[] {
  const quoted = proposal.files.map((file) => `'${file.replaceAll("'", "'\\''")}'`).join(" ");
  return [`git add ${quoted}`, `git commit -m '${proposal.message.replaceAll("'", "'\\''")}'`];
}
