// Minimal interactive prompts on node:readline (no dependencies). Without a TTY they return defaults.
import readline from 'node:readline';
const tty = () => !!process.stdin.isTTY && !!process.stdout.isTTY;
export const interactive = tty;
const color = (code) => (s) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = color(32);
export const yellow = color(33);
export const red = color(31);
export const dim = color(2);
export const bold = color(1);
export const cyan = color(36);
export const ok = (s) => `${green('✓')} ${s}`;
export const warn = (s) => `${yellow('⚠')} ${s}`;
export const fail = (s) => `${red('✗')} ${s}`;
export async function select(question, choices, initial = 0) {
    if (!tty())
        return choices[initial].value;
    const out = process.stdout;
    const input = process.stdin;
    let index = initial;
    out.write(`\n${bold(question)}\n\n`);
    const render = (first) => {
        if (!first)
            out.write(`\x1b[${choices.length}A`);
        choices.forEach((c, i) => {
            const line = i === index ? `${cyan('❯')} ${cyan(c.label)}` : `  ${c.label}`;
            out.write(`\x1b[2K${line}${c.hint ? ` ${dim(c.hint)}` : ''}\n`);
        });
    };
    render(true);
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    return new Promise((resolve) => {
        const onKey = (_, key) => {
            if (key.ctrl && key.name === 'c') {
                cleanup();
                out.write('\n');
                process.exit(130);
            }
            if (key.name === 'up' || key.name === 'k')
                index = (index - 1 + choices.length) % choices.length;
            else if (key.name === 'down' || key.name === 'j')
                index = (index + 1) % choices.length;
            else if (key.name === 'return' || key.name === 'enter') {
                cleanup();
                resolve(choices[index].value);
                return;
            }
            else
                return;
            render(false);
        };
        const cleanup = () => {
            input.off('keypress', onKey);
            input.setRawMode(false);
            input.pause();
        };
        input.on('keypress', onKey);
    });
}
export async function ask(question, opts = {}) {
    if (!tty()) {
        const value = opts.initial ?? '';
        const error = opts.validate?.(value);
        if (error)
            throw new Error(`${question} ${error} (non-interactive: pass it as a flag)`);
        return value;
    }
    for (;;) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        if (opts.secret) {
            // Hide typed characters, keep the prompt itself visible.
            rl._writeToOutput = (s) => {
                if (s.includes(question))
                    process.stdout.write(s);
                else if (s === '\r\n' || s === '\n')
                    process.stdout.write(s);
            };
        }
        const suffix = opts.initial ? dim(` (${opts.secret ? '•••' : opts.initial})`) : '';
        const answer = await new Promise((resolve) => rl.question(`\n${bold(question)}${suffix} `, resolve));
        rl.close();
        if (opts.secret)
            process.stdout.write('\n');
        const value = answer.trim() || opts.initial || '';
        const error = opts.validate?.(value);
        if (!error)
            return value;
        console.log(fail(error));
    }
}
export const confirm = async (question, initial = true) => select(question, [{ value: true, label: 'Yes' }, { value: false, label: 'No' }], initial ? 0 : 1);
