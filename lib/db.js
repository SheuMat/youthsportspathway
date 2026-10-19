import postgres from 'postgres';

let client;

export function db() {
  if (!client) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    // prepare:false keeps this compatible with Supabase/Neon transaction poolers.
    client = postgres(process.env.DATABASE_URL, { max: 3, prepare: false, idle_timeout: 20 });
  }
  return client;
}

// Places taken = active members plus pending sign-ups whose hold has not expired.
export async function slotAvailability(sql, excludeMemberId = null) {
  const rows = await sql`
    SELECT s.code, s.label, s.capacity,
      COUNT(m.id) FILTER (
        WHERE (m.status = 'active' OR (m.status = 'pending' AND m.hold_expires > now()))
          AND (${excludeMemberId}::uuid IS NULL OR m.id <> ${excludeMemberId}::uuid)
      )::int AS taken
    FROM slots s
    LEFT JOIN member_slots ms ON ms.slot_code = s.code
    LEFT JOIN members m ON m.id = ms.member_id
    GROUP BY s.code ORDER BY s.code`;
  return Object.fromEntries(rows.map((r) => [r.code, { ...r, remaining: Math.max(0, r.capacity - r.taken) }]));
}
