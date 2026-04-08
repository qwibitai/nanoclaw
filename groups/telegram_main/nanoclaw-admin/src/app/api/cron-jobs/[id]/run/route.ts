import { exec } from "child_process";
import { promisify } from "util";
import path from "path";

const execAsync = promisify(exec);

// Maps task IDs to the npm script that runs them
const TASK_SCRIPT_MAP: Record<string, string> = {
  "task-1774220446934-tx55zc": "job:price-drops",
};

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const script = TASK_SCRIPT_MAP[id];

  if (!script) {
    return Response.json(
      { ok: false, error: `No script mapped for task ${id}` },
      { status: 404 }
    );
  }

  const projectDir = path.resolve(process.cwd());

  try {
    const { stdout, stderr } = await execAsync(`npm run ${script}`, {
      cwd: projectDir,
      timeout: 300_000, // 5 min max
      env: { ...process.env },
    });

    // Try to parse JSON output from the job script
    const output = stdout || stderr || "";
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return Response.json(parsed);
      } catch {}
    }

    return Response.json({ ok: true, message: output.trim().slice(0, 500) });
  } catch (err: unknown) {
    const error = err as { stderr?: string; stdout?: string; message?: string };
    const output = error.stderr || error.stdout || error.message || String(err);
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return Response.json({ ...parsed, ok: false }, { status: 500 });
      } catch {}
    }
    return Response.json(
      { ok: false, error: output.slice(0, 500) },
      { status: 500 }
    );
  }
}
