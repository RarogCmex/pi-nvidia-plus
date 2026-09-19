/**
 * Ребёнок двухпроцессной пробы разделяемого карантина (test/proxy-pool.test.ts,
 * проверка 27): attaches к стейт-файлу (или нет — при аргументе `noattach`),
 * печатает statusFor пула в stdout JSON. Карантин, поставленный родителем,
 * должен быть виден здесь до первого pick.
 */
import { ProxyRotator } from "../../extensions/proxy-pool.ts";

const [file, hrefA, hrefB, noAttach] = process.argv.slice(2);
const r = new ProxyRotator({ random: () => 0 });
if (noAttach !== "noattach") r.attachSharedState(file);
r.setPool([hrefA, hrefB]);
console.log(JSON.stringify(r.statusFor(Date.now()).map((s) => ({ display: s.display, state: s.state }))));
