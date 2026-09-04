// Silence Node's ExperimentalWarning for node:sqlite (stable enough for our use;
// every other warning still prints).
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') process.stderr.write(`${w.stack ?? w.message}\n`); });
const origEmit = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
  const name = typeof warning === 'object' ? warning.name : type;
  if (name === 'ExperimentalWarning' || type === 'ExperimentalWarning') return;
  return origEmit.call(process, warning, ...args);
};
