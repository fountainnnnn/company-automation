import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://odsofzzjniafttbdhtye.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_SSXeRx2cQrhSH9QX3JrLbg_pkVvu_rC";

export const MEDIA_BUCKET = "site-media";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
