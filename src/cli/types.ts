export interface Command {
  name: string;
  summary: string;
  run(argv: string[]): Promise<number>;
}
