package local.nilabot.wechathook;
import java.util.*;
public final class GroupImageMembersTest {
    private static void require(boolean ok){if(!ok)throw new AssertionError();}
    public static void main(String[] args){
        List<GroupImageMembers.Member> members=Arrays.asList(
            new GroupImageMembers.Member("wxid_self","自己的群昵称","自己昵称"),
            new GroupImageMembers.Member("wxid_a","群员A","共同昵称","备注A","account_a"),
            new GroupImageMembers.Member("wxid_b","群员B","共同昵称","备注B","account_b"));
        Set<String> none=Collections.emptySet();
        for(String self:Arrays.asList("","我","self"))require(GroupImageMembers.resolve(members,self,"wxid_self",none).get(0).id.equals("wxid_self"));
        for(String label:Arrays.asList("群员A","@群员Ａ","备注A","account_a","wxid_a"))require(GroupImageMembers.resolve(members,label,"wxid_self",none).get(0).id.equals("wxid_a"));
        require(GroupImageMembers.resolve(members,"共同昵称","wxid_self",none).size()==2);
        require(GroupImageMembers.resolve(members,"共同昵称","wxid_self",Collections.singleton("wxid_b")).get(0).id.equals("wxid_b"));
        require(GroupImageMembers.resolve(members,"共同昵称","wxid_self",new HashSet<>(Arrays.asList("wxid_a","wxid_b"))).size()==2);
        require(GroupImageMembers.resolve(members,"另一个群的成员","wxid_self",none).isEmpty());
        require(GroupImageMembers.resolve(members,"群员","wxid_self",none).isEmpty());
        require(GroupImageMembers.resolve(members,"wxid_absent","wxid_self",none).isEmpty());
        System.out.println("Group image member selection passed: self, exact names, IDs, duplicates, mentions and isolation.");
    }
}
