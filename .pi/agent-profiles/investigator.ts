// investigator 角色的默认绑定。路径必须是绝对值：Node 不展开 import 说明符里的 `~`。
// 绑定写在 .pi/subagent-bindings.json 的 "investigator" 键下；文件或键缺失时 fail closed。
import { profile } from "/home/shay/extensions/pi-subagents-extend/packages/pi-plugin/src/profile.ts";

export default profile("investigator");
