import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
export default defineConfig([...nextVitals,...nextTs,globalIgnores([".next/**","draft/**","public/**",".agents/**","next-env.d.ts"]),{rules:{"@next/next/no-img-element":"off","@next/next/no-page-custom-font":"off"}}]);
