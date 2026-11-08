import type { AgentRunRow } from "../runs/dbTypes";
import { RunError } from "../runs/errors";
import type { RunRuntime } from "./runtime";

export const assertPublicationArtifact = (
    run: AgentRunRow,
    runtime: RunRuntime,
) => {
    const { completed, artifact } = runtime;
    if (
        !completed ||
        !artifact ||
        completed.baseCommit !== run.baseCommit ||
        artifact.headCommit !== completed.headCommit
    )
        throw new RunError(
            "INVALID_INPUT",
            "Workspace artifact does not match the selected base and completed head",
        );
    for (const path of [
        ...Object.keys(artifact.files),
        ...completed.changedFiles,
    ]) {
        if (
            path.startsWith("/") ||
            path.includes("\\") ||
            path.includes("\0") ||
            path
                .split("/")
                .some((part) => part === ".." || part === "." || part === "") ||
            path === ".git" ||
            path.startsWith(".git/")
        )
            throw new RunError("INVALID_INPUT", "Unsafe artifact path");
    }
    for (const path of completed.changedFiles) {
        if (
            path.startsWith(".github/workflows/") ||
            !artifact.tracked.includes(path)
        )
            throw new RunError(
                "INVALID_INPUT",
                "Changed files are outside the supported publication artifact",
            );
    }
};
