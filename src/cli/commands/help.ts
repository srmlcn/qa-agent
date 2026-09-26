import type { Command } from "../types.js";

export const command: Command = {
  name: "help",
  summary: "list available commands",
  async run(): Promise<number> {
    return 0;
  },
};
