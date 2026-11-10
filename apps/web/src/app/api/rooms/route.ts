import { handleRooms } from "@/server/composition/rooms.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = handleRooms;
export const POST = handleRooms;
