import { endPrompt, startPrompt } from "@reliverse/rempts";

export async function showStartPrompt(isDev: boolean, currentVersion: string) {
  await startPrompt({
    titleColor: "inverse",
    clearConsole: false,
    packageName: "bleump",
    packageVersion: currentVersion,
    isDev,
  });
}
export async function showEndPrompt() {
  await endPrompt({
    title:
      "❤️  Please support bleump: https://github.com/sponsors/blefnk\n│  📝  Feedback: https://github.com/blefnk/bleump/issues",
    titleColor: "dim",
  });
}
