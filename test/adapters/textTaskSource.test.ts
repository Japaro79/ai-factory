import { describe, expect, it } from "vitest";
import { TextTaskSource } from "../../src/adapters/textTaskSource.ts";

const at = new Date(Date.UTC(2026, 10, 18, 9, 5, 0));

describe("TextTaskSource", () => {
  it("turns a typed request into a task with a unique, readable id", async () => {
    const task = await new TextTaskSource("Añade un botón de exportar a CSV en ajustes.\nDebe incluir las fechas.", at).get();
    expect(task).toEqual({
      id: "text-20261118-0905-anade-un-boton-de-exportar-a-csv",
      source: "text",
      externalId: 0,
      title: "Añade un botón de exportar a CSV en ajustes.",
      body: "Añade un botón de exportar a CSV en ajustes.\nDebe incluir las fechas.",
      url: "",
    });
  });

  it("shortens a long first line for the title", async () => {
    const task = await new TextTaskSource("x".repeat(120), at).get();
    expect(task.title).toHaveLength(80);
    expect(task.title.endsWith("…")).toBe(true);
  });

  it("rejects an empty request", () => {
    expect(() => new TextTaskSource("   \n ", at)).toThrow(/empty/);
  });

  it("has nothing pending and never writes to GitHub", async () => {
    const source = new TextTaskSource("Cambia el color", at);
    expect(await source.listPending()).toHaveLength(1);
    await expect(source.markStatus(await source.get(), "pr-opened")).resolves.toBeUndefined();
    await expect(source.comment(await source.get(), "hi")).resolves.toBeUndefined();
  });
});
