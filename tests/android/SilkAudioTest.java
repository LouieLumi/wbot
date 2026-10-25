package local.nilabot.wechathook;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
public final class SilkAudioTest {
    public static void main(String[] args) throws Exception {
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();bytes.write("\u0002#!SILK_V3".getBytes(StandardCharsets.US_ASCII));
        for(int i=0;i<50;i++)bytes.write(new byte[]{1,0,42});
        byte[] data=bytes.toByteArray();if(SilkAudio.duration(data)!=1000)throw new AssertionError();
        for(byte[] bad:new byte[][]{Arrays.copyOf(data,12),Arrays.copyOf(data,data.length-1),new byte[0]}){
            try{SilkAudio.duration(bad);throw new AssertionError("accepted malformed audio");}catch(IllegalArgumentException expected){}
        }
        data[10]=0;try{SilkAudio.duration(data);throw new AssertionError("accepted zero packet");}catch(IllegalArgumentException expected){}
        System.out.println("SilkAudio packet and duration checks passed");
    }
}
