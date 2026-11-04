// 本机材质源的方块目录与卡面玩家图片的取图地址。页面、流程与启动层不能直接引入 mc/，经这里取用。

export { blockDisplayName, getBlockCatalog, useBlockCatalog, type BlockCatalog, type CatalogBlock } from "../../mc/catalog";
export { coverImageUrl } from "../../mc/art";
