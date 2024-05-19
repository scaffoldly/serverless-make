import proc from "child_process";
import which from "which";

export const exec = (
  argv: string[],
  workdir: string,
  env: { [key: string]: string | undefined }
): Promise<void> => {
  return new Promise((resolve, reject) => {
    let command: string;
    try {
      command = which.sync(argv[0]);
    } catch (e) {
      reject(
        new Error(`Unable to locate the '${argv[0]}' command on this system`)
      );
      return;
    }

    const p = proc.spawn(command, argv.slice(1), {
      shell: true,
      env,
      cwd: workdir,
    });

    p.on("error", (err) => {
      reject(err);
    });

    p.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Command ${argv[0]} exited with code ${code}`));
        return;
      }
      resolve();
    });

    p.stdin.pipe(process.stdin);
    p.stdout.pipe(process.stdout);
    p.stderr.pipe(process.stderr);
  });
};
