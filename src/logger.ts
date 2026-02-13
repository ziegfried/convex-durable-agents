const DEBUG_ENABLED = false;

export class Logger {
  constructor(public readonly name: string) {}

  debug(message: string, ...data: any[]): void {
    if (DEBUG_ENABLED) {
      console.debug(`[${this.name}] ${message}`, ...data);
    }
  }

  info(message: string, ...data: any[]): void {
    console.info(`[${this.name}] ${message}`, ...data);
  }

  warn(message: string, ...data: any[]): void {
    console.warn(`[${this.name}] ${message}`, ...data);
  }

  error(message: string, ...data: any[]): void {
    console.error(`[${this.name}] ${message}`, ...data);
  }
}
