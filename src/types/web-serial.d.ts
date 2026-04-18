interface SerialPortInfo {
  usbVendorId?: number
  usbProductId?: number
}

interface SerialPort {
  open(options: SerialOptions): Promise<void>
  close(): Promise<void>
  readable: ReadableStream
  writable: WritableStream
  getInfo(): SerialPortInfo
}

interface SerialOptions {
  baudRate: number
  dataBits?: number
  stopBits?: number
  parity?: string
  bufferSize?: number
  flowControl?: string
}

interface Navigator {
  serial: {
    requestPort(options?: any): Promise<SerialPort>
    getPorts(): Promise<SerialPort[]>
  }
  usb: {
    requestDevice(options: any): Promise<USBDevice>
    getDevices(): Promise<USBDevice[]>
  }
  bluetooth: {
    requestDevice(options: any): Promise<BluetoothDevice>
  }
}

interface USBDevice {
  serialNumber?: string
  productName?: string
  manufacturerName?: string
}

interface BluetoothRemoteGATTServer {
  connected: boolean
  device: BluetoothDevice
  connect(): Promise<BluetoothRemoteGATTServer>
  disconnect(): void
  getPrimaryService(service: string | number): Promise<BluetoothRemoteGATTService>
  getPrimaryServices(service?: string | number): Promise<BluetoothRemoteGATTService[]>
}

interface BluetoothRemoteGATTService {
  device: BluetoothDevice
  uuid: string
  isPrimary: boolean
  getCharacteristic(characteristic: string): Promise<BluetoothRemoteGATTCharacteristic>
  getCharacteristics(characteristic?: string): Promise<BluetoothRemoteGATTCharacteristic[]>
}

interface BluetoothRemoteGATTCharacteristic {
  service: BluetoothRemoteGATTService
  uuid: string
  properties: BluetoothCharacteristicProperties
  value?: DataView
  readValue(): Promise<DataView>
  writeValue(value: BufferSource): Promise<void>
  writeValueWithResponse(value: BufferSource): Promise<void>
  writeValueWithoutResponse(value: BufferSource): Promise<void>
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void
}

interface BluetoothCharacteristicProperties {
  broadcast: boolean
  read: boolean
  writeWithoutResponse: boolean
  write: boolean
  notify: boolean
  indicate: boolean
  authenticatedSignedWrites: boolean
  reliableWrite: boolean
  writableAuxiliaries: boolean
}

interface BluetoothDevice {
  id: string
  name?: string
  gatt?: BluetoothRemoteGATTServer
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void
}

interface LogOptions {
  showTime: boolean
  showMs: boolean
  showHex: boolean
  showText: boolean
  showNewline: boolean
  autoScroll: boolean
  timeOut: number
}