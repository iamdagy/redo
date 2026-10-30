import { serverHasKey } from "@/lib/comfy";

export const runtime = "nodejs";

// La interfaz pregunta si este servidor trae su propia clave; si no, pide la del visitante antes de generar.
export function GET() {
  return Response.json({ serverKey: serverHasKey() });
}
