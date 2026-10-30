// Arranca Electron sin ELECTRON_RUN_AS_NODE (VS Code lo define y haría que Electron se comportara como Node).
const { spawn } = require('child_process');
const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env, cwd: require('path').join(__dirname, '..') });
child.on('close', (code) => process.exit(code ?? 0));
