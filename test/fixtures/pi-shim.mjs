#!/usr/bin/env node
// 测试垫片：模拟 pi 的 CLI 行为——打印 cwd 与参数，验证脚本转义与 PATH 注入。
process.stdout.write(`${process.cwd()}\n`);
for (const arg of process.argv.slice(2)) process.stdout.write(`${arg}\n`);
