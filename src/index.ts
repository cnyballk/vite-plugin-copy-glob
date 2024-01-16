import { join, isAbsolute, parse, relative } from "node:path";
import { statSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { Plugin } from "vite";
import { copy, pathExists, mkdirs } from "fs-extra";
import { globby, Options as GlobbyOptions } from "globby";

export interface Target {
  src: string | string[];
  dest: string | ((to: string) => string);
  rename?: string | ((name: string) => string);
  flatten?: boolean;
  copyfilePath?: boolean;
  transform?: (
    buf: Buffer,
    matchedPath: string
  ) => string | Buffer | Promise<string | Buffer>;
}

export interface Options {
  hook?: string;
  watch?: boolean;
  enforce?: "pre" | "post";
  globbyOptions?: GlobbyOptions;
  cwd?: string;
  targets: Target[];
}

function makeCopy(
  transform?: (
    buf: Buffer,
    matchedPath: string
  ) => string | Buffer | Promise<string | Buffer>
) {
  return transform
    ? function (from: string, to: string) {
        return readFile(from)
          .then((buf: Buffer) => transform(buf, from))
          .then((data: string | Buffer) => {
            const { dir } = parse(to);
            return pathExists(dir)
              .then((itDoes) => {
                if (!itDoes) {
                  return mkdirs(dir);
                }
              })
              .then(() => {
                return writeFile(to, data);
              });
          });
      }
    : copy;
}

function transformName(
  name: string,
  rename?: string | ((name: string) => string)
): string {
  if (typeof rename === "function") {
    return rename(name) || name;
  }

  return rename || name;
}

export default function createPlugin(opts: Options): Plugin {
  const {
    hook = "writeBundle",
    enforce,
    targets,
    watch = false,
    cwd = process.cwd(),
    globbyOptions,
  } = opts || {};

  const plugin: Plugin = {
    name: "vite:cp",
  };

  if (enforce) {
    plugin.enforce = enforce;
  }

  if (!Array.isArray(targets) || !targets.length) {
    return plugin;
  }

  const toAbsolutePath = (pth: string) => {
    if (!isAbsolute(pth)) {
      pth = join(cwd, pth);
    }
    return pth;
  };

  if (watch) {
    plugin["load"] = async function () {
      targets.map(({ src, dest, rename, flatten, transform }) => {
        globby(src, globbyOptions).then((matchedPaths) => {
          matchedPaths.map((path) => this.addWatchFile(path));
        });
      });
    };
  }

  plugin[hook] = async function () {
    const startTime = Date.now();
    await Promise.all(
      targets.map(({ src, dest, rename, flatten, transform }) => {
        const cp = makeCopy(transform);
        const glob = (pattern: string) => {
          let notFlatten = false;
          try {
            notFlatten = statSync(pattern).isDirectory() && flatten === false;
          } catch (e) {}

          return globby(pattern, globbyOptions).then((matchedPaths) => {
            if (!matchedPaths.length) {
              throw new Error(`Could not find files with "${pattern}"`);
            }

            return matchedPaths.map((matchedPath) => {
              matchedPath = toAbsolutePath(matchedPath);
              let actualDest = dest as string;
              if (typeof dest === "function") {
                actualDest = dest(parse(matchedPath).dir);
              }
              const outputToDest = notFlatten
                ? function (matchedPath: string) {
                    const tmp = parse(relative(pattern, matchedPath));
                    return cp(
                      matchedPath,
                      join(actualDest, tmp.dir, transformName(tmp.base, rename))
                    );
                  }
                : function (matchedPath: string) {
                    return cp(
                      matchedPath,
                      join(
                        actualDest,
                        transformName(parse(matchedPath).base, rename)
                      )
                    );
                  };
              return outputToDest(matchedPath);
            });
          });
        };

        if (typeof src === "string") {
          return glob(src);
        } else if (Array.isArray(src)) {
          return Promise.all(src.map(glob));
        }

        return null;
      })
    );

    console.info(
      `Done in ${Number((Date.now() - startTime) / 1000).toFixed(1)}s`
    );
  };

  return plugin;
}
