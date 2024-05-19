import "path";
import { exit } from "process";
import { exec } from "./exec";
import path from "path";
import { watch as chokidar } from "chokidar";

type PluginName = "make";
const PLUGIN_NAME: PluginName = "make";

type PluginConfig = {
  target?: string; // Default is "", which will run "_PHONY" target
  makefile?: string; // Default is "./Makefile"
  reloadHandler?: boolean; // Default is false
  watch?: string[]; // Default is []
  hooks?: {
    [key: string]: string;
  };
};

type ServerlessCustom = {
  make?: PluginConfig;
  "serverless-offline"?: {
    location?: string;
  };
};

type ServerlessService = {
  service: string;
  custom?: ServerlessCustom;
  provider: {
    stage: string;
    environment?: { [key: string]: string };
  };
  getAllFunctions: () => string[];
  getFunction: (functionName: string) => {
    name: string;
    events?: any[];
  };
};

type ServerlessConfig = {
  servicePath: string;
};

type Serverless = {
  service: ServerlessService;
  pluginManager: {
    spawn: (command: string) => Promise<void>;
    hooks?: {
      [key: string]: any;
    };
  };
  config: any;
};

type Options = {
  verbose?: boolean;
  log?: ServerlessLog;
};

type ServerlessLog = ((message: string) => void) & {
  verbose: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string) => void;
};

class Log {
  constructor(private options: Options) {}

  static msg = (message: string) => {
    return `[${PLUGIN_NAME}] ${message}`;
  };

  log = (message: string) => {
    if (this.options.log) {
      this.options.log(Log.msg(message));
    } else {
      console.log(Log.msg(message));
    }
  };

  verbose = (message: string) => {
    if (this.options.log) {
      this.options.log.verbose(Log.msg(message));
    } else {
      if (this.options.verbose) {
        console.log(Log.msg(message));
      }
    }
  };

  warning = (message: string) => {
    if (this.options.log) {
      this.options.log.warning(Log.msg(message));
    } else {
      console.warn(Log.msg(message));
    }
  };

  error = (message: string) => {
    if (this.options.log) {
      this.options.log.error(Log.msg(message));
    } else {
      console.error(Log.msg(message));
    }
  };
}

type Hooks = {
  [key: string]: () => Promise<void>;
};

type Commands = {
  [key: string]:
    | Commands
    | {
        lifecycleEvents?: string[];
        type?: string;
      };
};

class ServerlessMake {
  log: Log;

  serverless: Serverless;
  serverlessConfig: ServerlessConfig;
  pluginConfig: PluginConfig;

  commands: Commands;
  hooks?: Hooks;

  constructor(serverless: Serverless, protected options: Options) {
    this.serverless = serverless;
    this.serverlessConfig = serverless.config;
    this.pluginConfig =
      (this.serverless.service.custom &&
        this.serverless.service.custom[PLUGIN_NAME]) ||
      {};

    this.log = new Log(options);

    this.commands = {
      [PLUGIN_NAME]: {
        made: {
          lifecycleEvents: [this.target || "_PHONY"],
          type: "entrypoint",
        },
      },
    };

    this.hooks = this.setupHooks();
  }

  get environment(): { [key: string]: string | undefined } {
    return {
      ...(process.env || {}),
      ...((((this.serverless || {}).service || {}).provider || {})
        .environment || {}),
    };
  }

  get target(): string {
    return this.pluginConfig.target || "";
  }

  setupHooks = () => {
    const hooks: Hooks = {
      initialize: async () => {},
      [`${PLUGIN_NAME}:made:${this.target || "_PHONY"}`]: async () => {
        this.log.verbose(`!!! ${PLUGIN_NAME}:made:${this.target || "_PHONY"}`);
      },
      "before:offline:start": async () => {
        this.log.verbose("before:offline:start");
        let errored = false;
        try {
          await this.build(this.pluginConfig.reloadHandler);
        } catch (e) {
          errored = true;
          if (e instanceof Error) {
            this.log.error(e.message);
          }
        } finally {
          if (errored) {
            exit(1);
          }
        }
      },
      "before:package:createDeploymentArtifacts": async () => {
        this.log.verbose("before:package:createDeploymentArtifacts");
        let errored = false;
        try {
          await this.build(false);
        } catch (e) {
          errored = true;
          if (e instanceof Error) {
            this.log.error(e.message);
          }
          throw e;
        } finally {
          if (errored) {
            exit(1);
          }
        }
      },
    };

    const pluginHooks = this.pluginConfig.hooks || {};

    Object.entries(pluginHooks).forEach(([hook, target]) => {
      if (hooks[hook] && hook !== `${PLUGIN_NAME}:made`) {
        this.log.warning(
          `Unable to override registered internal hook "${hook}"!`
        );
        return;
      }
      hooks[hook] = async () => {
        this.log.verbose(hook);
        await this.make(target);
      };
    });

    return hooks;
  };

  make = async (target: string): Promise<{ makefile: string }> => {
    const makefile = path.join(
      this.serverlessConfig.servicePath,
      this.pluginConfig.makefile || "./Makefile"
    );
    const workdir = path.dirname(makefile);

    const command = ["make", "-f", makefile, target];

    this.log.verbose(`Making "${target}"...`);

    await exec(command, workdir, this.environment);

    this.log.log(`Made "${target}"!`);

    return { makefile };
  };

  build = async (watch?: boolean): Promise<void> => {
    const { makefile } = await this.make(this.target);

    if (watch) {
      const paths = [
        ...[makefile],
        ...(this.pluginConfig.watch || []).map((p) =>
          path.join(this.serverlessConfig.servicePath, p)
        ),
      ];

      this.log.verbose(
        `Watching for changes in:\n${paths.map((p) => ` - ${p}`).join(`\n`)}`
      );

      chokidar(paths, {
        ignoreInitial: true,
        usePolling: true,
        interval: 100,
        awaitWriteFinish: {
          stabilityThreshold: 500,
          pollInterval: 100,
        },
      }).on("all", async () => {
        this.log.log("Change detected, rebuilding...");
        try {
          await this.build(false);
        } catch (e) {
          if (e instanceof Error) {
            this.log.error(e.message);
          }
        }
      });
    }

    const spawn = `${PLUGIN_NAME}:made`;
    try {
      await this.serverless.pluginManager.spawn(`${PLUGIN_NAME}:made`);
    } catch (e) {
      if (e instanceof Error) {
        this.log.warning(`Unable to spawn ${spawn}`);
      }
    }
  };
}

module.exports = ServerlessMake;
