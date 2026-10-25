package local.nilabot.wechathook;
import java.nio.charset.StandardCharsets;

/** Only Tencent SILK with 20ms packets; duration is derived from the payload. */
public final class SilkAudio {
    public static int duration(byte[] data) {
        byte[] header="\u0002#!SILK_V3".getBytes(StandardCharsets.US_ASCII);
        if(data==null||data.length<13||data.length>1024*1024)throw new IllegalArgumentException("voice_size");
        for(int i=0;i<header.length;i++)if(data[i]!=header[i])throw new IllegalArgumentException("voice_header");
        int offset=10,frames=0;
        while(offset<data.length){
            if(offset+2>data.length)throw new IllegalArgumentException("voice_packet");
            int size=(data[offset]&255)|((data[offset+1]&255)<<8);offset+=2;
            if(size==0||size>1250||offset+size>data.length)throw new IllegalArgumentException("voice_packet");
            offset+=size;frames++;
        }
        int duration=frames*20;
        if(duration<1000||duration>60000)throw new IllegalArgumentException("voice_duration");
        return duration;
    }
}
