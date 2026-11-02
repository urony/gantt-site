// אימות חתימה דיגיטלית Ed25519 (RFC 8032), בלי תלות חיצונית. מיועד לאימות בלבד (החתימה נעשית אצל אורי בכלי השחרור).
// נכתב כפונקציה אחת עצמאית ללא תחביר מודולים פנימי, כדי שאפשר יהיה להטמיע את אותו הקוד בדיוק בשרת של המורה (Apps Script)
// ובמשגר (דפדפן). sha512 מוזרק: (מערך בתים 0..255) => מערך בתים 0..255. BigInt נתמך ב-V8 של Apps Script.
// מחזיר true רק לחתימה תקינה. כל קלט פגום מחזיר false ולא זורק.
export function ed25519Verify(sig, msg, pub, sha512) {
  try {
    var BI = BigInt; // בלי מילולי BigInt (למשל 1n): בדיקת התחביר של Google בהעלאת פרויקט דוחה אותם
    if (!sig || !pub || sig.length !== 64 || pub.length !== 32) return false;
    var P = (BI("1") << BI("255")) - BI("19");
    var L = (BI("1") << BI("252")) + BI("27742317777372353535851937790883648493");
    var mod = function (a) { var r = a % P; return r >= BI("0") ? r : r + P; };
    var pow = function (b, e) { var r = BI("1"); b = mod(b); while (e > BI("0")) { if (e & BI("1")) r = r * b % P; b = b * b % P; e >>= BI("1"); } return r; };
    var inv = function (a) { return pow(a, P - BI("2")); };
    var D = mod(-BI("121665") * inv(BI("121666")));
    var I = pow(BI("2"), (P - BI("1")) / BI("4"));
    var le = function (bytes) { var n = BI("0"); for (var i = bytes.length - 1; i >= 0; i--) n = (n << BI("8")) | BigInt(bytes[i]); return n; };
    var dec = function (b) {
      var bb = Array.prototype.slice.call(b); var sign = bb[31] >> 7; bb[31] &= 127;
      var y = le(bb); if (y >= P) return null;
      var y2 = y * y % P; var x2 = mod((y2 - BI("1")) * inv(D * y2 + BI("1")));
      var x = pow(x2, (P + BI("3")) / BI("8"));
      if (mod(x * x - x2) !== BI("0")) x = x * I % P;
      if (mod(x * x - x2) !== BI("0")) return null;
      if (x === BI("0") && sign) return null;
      if (Number(x & BI("1")) !== sign) x = P - x;
      return [x, y, BI("1"), x * y % P];
    };
    var add = function (p, q) {
      var A = mod((p[1] - p[0]) * (q[1] - q[0])); var B = mod((p[1] + p[0]) * (q[1] + q[0]));
      var C = mod(p[3] * BI("2") * D * q[3]); var DD = mod(p[2] * BI("2") * q[2]);
      var E = B - A; var F = DD - C; var G = DD + C; var H = B + A;
      return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
    };
    var mul = function (p, k) { var r = [BI("0"), BI("1"), BI("1"), BI("0")]; var q = p; while (k > BI("0")) { if (k & BI("1")) r = add(r, q); q = add(q, q); k >>= BI("1"); } return r; };
    var by = mod(BI("4") * inv(BI("5"))); var byBytes = []; for (var i = 0, t = by; i < 32; i++, t >>= BI("8")) byBytes.push(Number(t & BI("255")));
    var B0 = dec(byBytes);
    var R = dec(Array.prototype.slice.call(sig, 0, 32)); var A0 = dec(pub);
    var S = le(Array.prototype.slice.call(sig, 32, 64));
    if (!R || !A0 || !B0 || S >= L) return false;
    var hin = Array.prototype.slice.call(sig, 0, 32).concat(Array.prototype.slice.call(pub), Array.prototype.slice.call(msg));
    var h = le(sha512(hin)) % L;
    var left = mul(B0, S); var right = add(R, mul(A0, h));
    return mod(left[0] * right[2]) === mod(right[0] * left[2]) && mod(left[1] * right[2]) === mod(right[1] * left[2]);
  } catch (e) { return false; }
}
