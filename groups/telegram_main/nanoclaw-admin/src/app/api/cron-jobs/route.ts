import { NextResponse } from "next/server";
import { getAllTasksWithLogs } from "@/lib/nanoclaw";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const tasks = getAllTasksWithLogs();
    return NextResponse.json(tasks);
  } catch (error) {
    console.error("Failed to load tasks:", error);
    return NextResponse.json(
      { error: "Failed to load scheduled tasks", detail: String(error) },
      { status: 500 }
    );
  }
}
