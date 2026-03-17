import os from 'os'

export function localIP(): string {
  for (const interfaces of Object.values(os.networkInterfaces())) {
    if (!interfaces) continue
    for (const network of interfaces) {
      if (network.family === 'IPv4' && !network.internal) return network.address
    }
  }
  return 'localhost'
}
