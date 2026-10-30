import { balance, keyFor, explainError } from "@/lib/comfy";

export const runtime = "nodejs";

// Saldo de la cuenta de la clave del visitante (o la del servidor), para mostrarlo antes de generar.
export async function GET(req: Request) {
  try {
    return Response.json(await balance(keyFor(req)), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const { status, body } = explainError(e);
    return Response.json(body, { status });
  }
}
