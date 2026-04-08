import { NextResponse } from "next/server";
import { getLastMergedPRs } from "@/lib/github";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const prs = await getLastMergedPRs(3);
    return NextResponse.json(prs);
  } catch (error) {
    console.error("Failed to load PRs:", error);
    return NextResponse.json(
      { error: "Failed to load pull requests", detail: String(error) },
      { status: 500 }
    );
  }
}
