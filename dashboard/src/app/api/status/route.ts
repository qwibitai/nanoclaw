import { NextResponse } from 'next/server';
import { readStatus } from '@/lib/status';

export const dynamic = 'force-dynamic';

export function GET() {
  const status = readStatus();
  if (!status) {
    return NextResponse.json(
      { error: 'Status unavailable' },
      { status: 503 },
    );
  }
  return NextResponse.json(status);
}
