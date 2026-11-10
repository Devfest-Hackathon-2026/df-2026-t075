import { handleCurrentUser } from "@/server/composition/auth.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handleCurrentUser;
export const PUT = handleCurrentUser;
