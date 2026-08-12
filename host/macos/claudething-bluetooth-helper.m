// SPDX-License-Identifier: MIT
// Minimal macOS RFCOMM sender for the ClaudeThing collector.

#import <Foundation/Foundation.h>
#import <IOBluetooth/IOBluetooth.h>

static const NSUInteger kMaximumFrameBytes = 1024U * 1024U + 52U;

@interface ClaudeThingRFCOMMDelegate : NSObject <IOBluetoothRFCOMMChannelDelegate>
@property(nonatomic, strong) NSMutableData *received;
@property(nonatomic) BOOL closed;
- (BOOL)hasCompleted;
- (BOOL)hasAcknowledged;
@end

@implementation ClaudeThingRFCOMMDelegate
- (instancetype)init {
    self = [super init];
    if (self) _received = [NSMutableData data];
    return self;
}

- (void)rfcommChannelData:(IOBluetoothRFCOMMChannel *)channel
                     data:(void *)bytes
                   length:(size_t)length {
    (void)channel;
    @synchronized(self) {
        if (self.received.length < 64U) {
            NSUInteger remaining = 64U - self.received.length;
            [self.received appendBytes:bytes length:MIN((NSUInteger)length, remaining)];
        }
    }
}

- (void)rfcommChannelClosed:(IOBluetoothRFCOMMChannel *)channel {
    (void)channel;
    @synchronized(self) {
        self.closed = YES;
    }
}

- (BOOL)hasCompleted {
    @synchronized(self) {
        return self.received.length >= 4U || self.closed;
    }
}

- (BOOL)hasAcknowledged {
    @synchronized(self) {
        NSData *success = [@"OK1\n" dataUsingEncoding:NSUTF8StringEncoding];
        return self.received.length >= success.length &&
            [[self.received subdataWithRange:NSMakeRange(0, success.length)] isEqualToData:success];
    }
}
@end


static void printError(NSString *message) {
    NSData *data = [[message stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
    [[NSFileHandle fileHandleWithStandardError] writeData:data];
}

static IOBluetoothDevice *findDevice(NSString *requestedAddress) {
    if (requestedAddress.length > 0) {
        NSString *normalized = [requestedAddress stringByReplacingOccurrencesOfString:@"-" withString:@":"];
        IOBluetoothDevice *device = [IOBluetoothDevice deviceWithAddressString:normalized];
        return device.isPaired ? device : nil;
    }

    NSMutableArray<IOBluetoothDevice *> *matches = [NSMutableArray array];
    for (IOBluetoothDevice *device in [IOBluetoothDevice pairedDevices] ?: @[]) {
        NSString *name = device.name ?: @"";
        if (device.isPaired && [name hasPrefix:@"ClaudeThing"]) [matches addObject:device];
    }
    return matches.count == 1 ? matches.firstObject : nil;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *address = nil;
        NSInteger channelID = 22;
        for (int index = 1; index < argc; index++) {
            NSString *argument = [NSString stringWithUTF8String:argv[index]];
            if ([argument isEqualToString:@"--address"] && index + 1 < argc) {
                address = [NSString stringWithUTF8String:argv[++index]];
            } else if ([argument isEqualToString:@"--channel"] && index + 1 < argc) {
                channelID = [[NSString stringWithUTF8String:argv[++index]] integerValue];
            } else {
                printError(@"Unsupported Bluetooth helper argument.");
                return 4;
            }
        }
        if (channelID < 1 || channelID > 30) {
            printError(@"RFCOMM channel must be 1 through 30.");
            return 4;
        }

        NSData *frame = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
        if (frame.length < 53U || frame.length > kMaximumFrameBytes) {
            printError(@"Snapshot frame is outside the permitted size.");
            return 4;
        }

        IOBluetoothDevice *device = findDevice(address);
        if (!device) {
            printError(@"Pair exactly one ClaudeThing display or specify its Bluetooth address.");
            return 3;
        }

        ClaudeThingRFCOMMDelegate *delegate = [[ClaudeThingRFCOMMDelegate alloc] init];
        IOBluetoothRFCOMMChannel *channel = nil;
        IOReturn opened = [device openRFCOMMChannelSync:&channel
                                          withChannelID:(BluetoothRFCOMMChannelID)channelID
                                               delegate:delegate];
        if (opened != kIOReturnSuccess || !channel) {
            printError(@"Unable to open the ClaudeThing Bluetooth channel.");
            return 5;
        }

        const uint8_t *bytes = frame.bytes;
        NSUInteger offset = 0;
        BluetoothRFCOMMMTU mtu = [channel getMTU];
        NSUInteger chunkLimit = MAX(1U, MIN((NSUInteger)mtu, (NSUInteger)UINT16_MAX));
        while (offset < frame.length) {
            UInt16 count = (UInt16)MIN(chunkLimit, frame.length - offset);
            IOReturn written = [channel writeSync:(void *)(bytes + offset) length:count];
            if (written != kIOReturnSuccess) {
                [channel closeChannel];
                printError(@"Bluetooth snapshot write failed.");
                return 6;
            }
            offset += count;
        }

        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:8.0];
        while (![delegate hasCompleted] && deadline.timeIntervalSinceNow > 0) {
            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                    beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        }
        BOOL acknowledged = [delegate hasAcknowledged];
        [channel closeChannel];
        if (!acknowledged) {
            printError(@"ClaudeThing did not acknowledge the snapshot.");
            return 7;
        }
        fputs("OK1\n", stdout);
        return 0;
    }
}
