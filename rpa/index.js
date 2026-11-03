import * as h3max from "./sites/h3max.js";
import * as polyface from "./sites/polyface.js";
import * as slice from "./sites/slice.js";

export const sites = { h3max, polyface, slice };

export const SITE_LIST = [
  { id: "h3max", name: "h3-max.me", url: "https://h3-max.me/" },
  { id: "polyface", name: "polyfaced.com", url: "https://polyfaced.com/" },
  { id: "slice", name: "slice.video", url: "https://slice.video/" },
];
