// すべての API 処理の登録。ここに足した処理は、台帳（security/access_ledger.yaml）にも載せないと起動しない。
import type { EndpointDef } from "../gate/types";
import { adminEndpoints } from "./admin";
import { authEndpoints } from "./auth";
import { customerEndpoints } from "./customer";
import { runnerEndpoints } from "./runner";
import { shopEndpoints } from "./shop";
import { systemEndpoints } from "./system";

export const ALL_ENDPOINTS: EndpointDef[] = [
  ...authEndpoints,
  ...systemEndpoints,
  ...customerEndpoints,
  ...runnerEndpoints,
  ...shopEndpoints,
  ...adminEndpoints,
] as EndpointDef[];
