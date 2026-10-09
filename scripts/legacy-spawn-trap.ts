Bun.spawn=(()=>{throw new Error('UNEXPECTED_SPAWN')}) as typeof Bun.spawn;
Bun.spawnSync=(()=>{throw new Error('UNEXPECTED_SPAWN')}) as typeof Bun.spawnSync;
process.kill=(()=>{throw new Error('UNEXPECTED_SIGNAL')}) as typeof process.kill;
