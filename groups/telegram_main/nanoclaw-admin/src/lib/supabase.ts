import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL_SOURCE = process.env.NEXT_PUBLIC_SUPABASE_URL_SOURCE || "";
const SUPABASE_KEY_SOURCE = process.env.SUPABASE_SERVICE_KEY_SOURCE || "";
const SUPABASE_URL_TARGET = process.env.NEXT_PUBLIC_SUPABASE_URL_TARGET || "";
const SUPABASE_KEY_TARGET = process.env.SUPABASE_SERVICE_KEY_TARGET || "";

let _source: SupabaseClient | undefined;
let _target: SupabaseClient | undefined;

export const getSupabaseSource = (): SupabaseClient =>
  (_source ??= createClient(SUPABASE_URL_SOURCE, SUPABASE_KEY_SOURCE));

export const getSupabaseTarget = (): SupabaseClient =>
  (_target ??= createClient(SUPABASE_URL_TARGET, SUPABASE_KEY_TARGET));