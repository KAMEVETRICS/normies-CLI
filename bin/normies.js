#!/usr/bin/env node

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const message = typeof warning === "string" ? warning : warning?.message;
  const type = typeof args[0] === "string" ? args[0] : warning?.name;
  if (type === "ExperimentalWarning" && message?.includes("SQLite")) {
    return;
  }

  return emitWarning(warning, ...args);
};

process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) {
    return;
  }

  console.error(`${warning.name}: ${warning.message}`);
});

const { main } = await import("../src/cli.js");

await main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
