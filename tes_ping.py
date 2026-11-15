import os, socket, struct, sys, time

host = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("SERVER_HOST", "")
port = int(sys.argv[2] if len(sys.argv) > 2 else os.environ.get("SERVER_PORT", "19132"))
magic = bytes.fromhex("00ffff00fefefefefdfdfdfd12345678")
pkt = b"\x01" + struct.pack(">Q", int(time.time() * 1000)) + magic + struct.pack(">Q", 123456789)

try:
    infos = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_DGRAM)
except Exception as e:
    print("Tes ping: DNS gagal:", e)
    sys.exit(0)

ips = sorted({i[4][0] for i in infos})
print("Tes ping: ada", len(ips), "alamat IPv4")
for n, ip in enumerate(ips, 1):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(4)
    hasil = None
    for _ in range(3):
        s.sendto(pkt, (ip, port))
        try:
            d, _a = s.recvfrom(2048)
            hasil = d[35:].decode("latin1", "ignore")[:160]
            break
        except socket.timeout:
            pass
    if hasil is not None:
        print(f"Tes ping: alamat {n} MEMBALAS -> {hasil}")
    else:
        print(f"Tes ping: alamat {n} TIDAK ada balasan (UDP)")
