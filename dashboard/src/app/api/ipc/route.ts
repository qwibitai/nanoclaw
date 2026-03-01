import { NextRequest, NextResponse } from 'next/server';
import { writeIpcCommand } from '@/lib/ipc';

export async function POST(request: NextRequest) {
  const body = await request.json();

  const { type, taskId } = body;

  if (!type || !taskId) {
    return NextResponse.json(
      { error: 'Missing type or taskId' },
      { status: 400 },
    );
  }

  const allowedTypes = ['pause_task', 'resume_task', 'cancel_task'];
  if (!allowedTypes.includes(type)) {
    return NextResponse.json(
      { error: `Invalid type: ${type}` },
      { status: 400 },
    );
  }

  writeIpcCommand({ type, taskId });
  return NextResponse.json({ ok: true });
}
