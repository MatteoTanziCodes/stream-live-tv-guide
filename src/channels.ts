import { Channel } from "./types";

// The channels we enrich. Each `tvpassportId` is the `<slug>/<stationId>` you see in
// https://www.tvpassport.com/tv-listings/stations/<tvpassportId>.
// `id` and `name` are matched against Debridio items (normalized, case-insensitive).
export const CHANNELS: Channel[] = [
  { id: "ca:tsn1", name: "TSN 1", tvpassportId: "tsn1/11", genre: "Sports", country: "CA" },
  { id: "ca:tsn2", name: "TSN 2", tvpassportId: "tsn2/4294", genre: "Sports", country: "CA" },
  { id: "ca:tsn3", name: "TSN 3", tvpassportId: "tsn3/13719", genre: "Sports", country: "CA" },
  { id: "ca:tsn4", name: "TSN 4", tvpassportId: "tsn4/279", genre: "Sports", country: "CA" },
  { id: "ca:tsn5", name: "TSN 5", tvpassportId: "tsn5/278", genre: "Sports", country: "CA" },
];
